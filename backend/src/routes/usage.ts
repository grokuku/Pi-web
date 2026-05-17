import { Router, type Request, type Response } from "express";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";

// ── Types ────────────────────────────────────────────

interface UsageRecord {
  timestamp: string; // ISO 8601
  modelId: string;
  providerId: string;
  modelName: string;
  mode: string; // "code" | "plan" | "review"
  inputTokens: number;
  outputTokens: number;
  projectId: string;
}

interface AggregatedBucket {
  key: string;       // "2026-05-17T14" or "2026-05-17" or "gemma4:31b"
  label: string;
  inputTokens: number;
  outputTokens: number;
}

// ── Storage ──────────────────────────────────────────

const USAGE_DIR = process.env.USAGE_DIR || "/data/usage";

function ensureDir() {
  if (!existsSync(USAGE_DIR)) {
    mkdirSync(USAGE_DIR, { recursive: true });
  }
}

function getDayFile(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return join(USAGE_DIR, `${y}-${m}-${d}.json`);
}

function readDayRecords(date: Date): UsageRecord[] {
  const file = getDayFile(date);
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return [];
  }
}

function appendRecord(record: UsageRecord) {
  ensureDir();
  const now = new Date();
  const file = getDayFile(now);
  const records = readDayRecords(now);
  records.push(record);
  writeFileSync(file, JSON.stringify(records), "utf-8");
}

function readRecordsInRange(from: Date, to: Date): UsageRecord[] {
  ensureDir();
  const all: UsageRecord[] = [];
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(23, 59, 59, 999);
  
  while (d <= end) {
    all.push(...readDayRecords(d));
    d.setDate(d.getDate() + 1);
  }
  
  return all.filter(r => {
    const ts = new Date(r.timestamp).getTime();
    return ts >= from.getTime() && ts <= end.getTime();
  });
}

// ── Aggregation ──────────────────────────────────────

function aggregateBy(
  records: UsageRecord[],
  groupBy: "hour" | "day" | "week" | "month" | "model"
): AggregatedBucket[] {
  const buckets = new Map<string, { input: number; output: number; label: string }>();

  for (const r of records) {
    const ts = new Date(r.timestamp);
    let key: string;
    let label: string;

    switch (groupBy) {
      case "hour": {
        const y = ts.getFullYear();
        const m = String(ts.getMonth() + 1).padStart(2, "0");
        const d = String(ts.getDate()).padStart(2, "0");
        const h = String(ts.getHours()).padStart(2, "0");
        key = `${y}-${m}-${d}T${h}`;
        label = `${h}:00`;
        break;
      }
      case "day": {
        const y = ts.getFullYear();
        const m = String(ts.getMonth() + 1).padStart(2, "0");
        const d = String(ts.getDate()).padStart(2, "0");
        key = `${y}-${m}-${d}`;
        const days = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];
        label = `${days[ts.getDay()]} ${d}/${m}`;
        break;
      }
      case "week": {
        // ISO week
        const d = new Date(ts);
        d.setHours(0, 0, 0, 0);
        const dayOfWeek = (d.getDay() + 6) % 7; // Monday = 0
        d.setDate(d.getDate() - dayOfWeek);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        key = `W${y}-${m}-${day}`;
        label = `Sem. ${y}-${m}-${day}`;
        break;
      }
      case "month": {
        const y = ts.getFullYear();
        const m = String(ts.getMonth() + 1).padStart(2, "0");
        key = `${y}-${m}`;
        const months = ["Jan", "Fév", "Mar", "Avr", "Mai", "Juin", "Juil", "Août", "Sep", "Oct", "Nov", "Déc"];
        label = `${months[ts.getMonth()]} ${y}`;
        break;
      }
      case "model": {
        key = r.modelName || r.modelId;
        label = key;
        break;
      }
      default:
        key = r.modelName || r.modelId;
        label = key;
    }

    const existing = buckets.get(key);
    if (existing) {
      existing.input += r.inputTokens;
      existing.output += r.outputTokens;
    } else {
      buckets.set(key, { input: r.inputTokens, output: r.outputTokens, label });
    }
  }

  // Sort by key
  return Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, val]) => ({
      key,
      label: val.label,
      inputTokens: val.input,
      outputTokens: val.output,
    }));
}

// ── Router ───────────────────────────────────────────

export const usageRouter = Router();

// Record a turn's token usage
export function recordUsage(record: UsageRecord) {
  try {
    appendRecord(record);
  } catch (e) {
    console.error("[usage] Failed to record usage:", e);
  }
}

// GET /api/usage?from=YYYY-MM-DD&to=YYYY-MM-DD&groupBy=hour|day|week|month|model
usageRouter.get("/", (req: Request, res: Response) => {
  try {
    const now = new Date();
    const fromStr = req.query.from as string;
    const toStr = req.query.to as string;
    const groupBy = (req.query.groupBy as string) || "day";

    // Default: last 7 days
    const from = fromStr ? new Date(fromStr) : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const to = toStr ? new Date(toStr) : now;

    from.setHours(0, 0, 0, 0);
    to.setHours(23, 59, 59, 999);

    const records = readRecordsInRange(from, to);

    // Filter by model if requested
    let filtered = records;
    if (req.query.model) {
      const modelFilter = req.query.model as string;
      filtered = records.filter(r => r.modelId === modelFilter || r.modelName === modelFilter);
    }

    const aggregated = aggregateBy(filtered, groupBy as any);
    const totalInput = aggregated.reduce((s, b) => s + b.inputTokens, 0);
    const totalOutput = aggregated.reduce((s, b) => s + b.outputTokens, 0);

    res.json({
      from: from.toISOString(),
      to: to.toISOString(),
      groupBy,
      totalInput,
      totalOutput,
      totalTokens: totalInput + totalOutput,
      buckets: aggregated,
    });
  } catch (e: any) {
    console.error("[usage] Error querying usage:", e);
    res.status(500).json({ error: e.message || "Failed to query usage" });
  }
});

// GET /api/usage/models — list all models that have usage records
usageRouter.get("/models", (_req: Request, res: Response) => {
  try {
    ensureDir();
    const models = new Map<string, string>(); // modelId -> modelName
    const files = readdirSync(USAGE_DIR).filter(f => f.endsWith(".json"));
    
    for (const file of files) {
      try {
        const records: UsageRecord[] = JSON.parse(readFileSync(join(USAGE_DIR, file), "utf-8"));
        for (const r of records) {
          if (!models.has(r.modelId)) {
            models.set(r.modelId, r.modelName || r.modelId);
          }
        }
      } catch {}
    }
    
    res.json(Array.from(models.entries()).map(([id, name]) => ({ id, name })));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});
