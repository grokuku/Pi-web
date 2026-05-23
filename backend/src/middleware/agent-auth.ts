import { type Request, type Response, type NextFunction } from "express";
import { validateToken, isAgentEnabled } from "../routes/agent-keys.js";

export function agentAuth(req: Request, res: Response, next: NextFunction): void {
  if (!isAgentEnabled()) {
    res.status(503).json({
      error: "Agent API not configured. Create an API key in Settings → API Keys.",
    });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header. Use: Bearer <token>" });
    return;
  }

  const token = authHeader.slice(7);
  const key = validateToken(token);
  if (!key) {
    res.status(403).json({ error: "Invalid agent token" });
    return;
  }

  next();
}
