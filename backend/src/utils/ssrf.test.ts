import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateHttpUrl } from "./ssrf.js";

// Mock de la résolution DNS pour contrôler les hôtes sans dépendre du réseau.
const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock("dns/promises", () => ({
  lookup: lookupMock,
}));

describe("validateHttpUrl — protection SSRF", () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  describe("IP privées / interdites bloquées par défaut", () => {
    it.each([
      "http://127.0.0.1/",
      "http://10.0.0.1/",
      "http://10.255.255.255/",
      "http://172.16.0.1/",
      "http://172.31.255.255/",
      "http://192.168.1.1/",
      "http://0.0.0.0/",
      "http://[::1]/",
    ])("bloque %s", async (url) => {
      await expect(validateHttpUrl(url)).rejects.toThrow(/Blocked/);
    });

    it("bloque l'adresse lien-local (metadata cloud 169.254.169.254)", async () => {
      await expect(validateHttpUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(
        /link-local/
      );
    });

    // SEC-04 (Lot A) : formes IPv4-mapped IPv6 normalisées en hexadécimal par
    // Node (l'ancien code ne reconnaissait que la forme pointée → contournement).
    describe("contournement IPv4-mapped IPv6 (SEC-04)", () => {
      it.each([
        "http://[::ffff:169.254.169.254]/", // forme pointée
        "http://[::ffff:127.0.0.1]/", // loopback — normalisé ::ffff:7f00:1
        "http://[::ffff:a9fe:a9fe]/", // forme hexadécimale de 169.254.169.254
        "http://[::ffff:10.0.0.1]/", // privé via mapped
        "http://[::ffff:7f00:1]/", // forme hexadécimale de 127.0.0.1
      ])("bloque %s (IPv4-mapped)", async (url) => {
        await expect(validateHttpUrl(url)).rejects.toThrow(/Blocked/);
      });

      it.each([
        "http://[2002:a9fe:a9fe::1]/", // 6to4 → 169.254.169.254
        "http://[2001:0:0:0:0:0:5601:5601]/", // Teredo → 169.254.169.254 (XOR 0xFFFF)
        "http://[64:ff9b::a9fe:a9fe]/", // NAT64 well-known → 169.254.169.254
        "http://[64:ff9b:1::a9fe:a9fe]/", // NAT64 local-use (RFC 8215)
      ])("bloque %s (plage de transition)", async (url) => {
        await expect(validateHttpUrl(url)).rejects.toThrow(/Blocked/);
      });

      it("autorise une IPv4-mapped publique si elle est explicitement permise", async () => {
        await expect(
          validateHttpUrl("http://[::ffff:127.0.0.1]/", { allowLoopback: true })
        ).resolves.toBe("http://[::ffff:7f00:1]/");
      });
    });
  });

  describe("adresses publiques autorisées", () => {
    it.each(["http://8.8.8.8/", "https://1.1.1.1/", "http://93.184.216.34/"])(
      "autorise %s",
      async (url) => {
        await expect(validateHttpUrl(url)).resolves.toBe(url);
      }
    );

    it.each([
      "http://[2606:4700:4700::1111]/", // IPv6 publique (Cloudflare)
      "http://[2001:4860:4860::8888]/", // IPv6 publique (Google)
      "http://[2002:808:808::]/", // 6to4 embarquant une IPv4 publique (8.8.8.8)
    ])("autorise l'IPv6 publique %s", async (url) => {
      await expect(validateHttpUrl(url)).resolves.toBe(url);
    });
  });

  describe("options d'autorisation explicites", () => {
    it("autorise loopback si allowLoopback", async () => {
      await expect(validateHttpUrl("http://127.0.0.1/", { allowLoopback: true })).resolves.toBe(
        "http://127.0.0.1/"
      );
    });

    it("autorise privé si allowPrivate", async () => {
      await expect(validateHttpUrl("http://10.0.0.1/", { allowPrivate: true })).resolves.toBe(
        "http://10.0.0.1/"
      );
    });

    it("autorise lien-local si allowLinkLocal", async () => {
      await expect(
        validateHttpUrl("http://169.254.169.254/", { allowLinkLocal: true })
      ).resolves.toBe("http://169.254.169.254/");
    });
  });

  describe("URL malveillantes", () => {
    it("bloque le userinfo @ vers une IP privée", async () => {
      await expect(validateHttpUrl("http://user:pass@127.0.0.1/")).rejects.toThrow(/Blocked/);
    });

    it("bloque le userinfo @ vers un hôte privé résolu par DNS", async () => {
      lookupMock.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
      await expect(validateHttpUrl("http://evil@internal.example/")).rejects.toThrow(
        /Blocked private/
      );
    });

    it("rejette un protocole non http(s)", async () => {
      await expect(validateHttpUrl("ftp://127.0.0.1/")).rejects.toThrow(/Only http\/https/);
    });

    it("rejette une URL invalide", async () => {
      await expect(validateHttpUrl("not a url")).rejects.toThrow(/Invalid URL/);
    });
  });

  describe("résolution DNS", () => {
    it("bloque un hôte qui résout vers une IP privée", async () => {
      lookupMock.mockResolvedValue([{ address: "192.168.0.10", family: 4 }]);
      await expect(validateHttpUrl("http://internal.example/")).rejects.toThrow(/Blocked private/);
    });

    it("bloque un hôte qui résout vers une IP lien-local", async () => {
      lookupMock.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
      await expect(validateHttpUrl("http://metadata.example/")).rejects.toThrow(/link-local/);
    });

    it("autorise un hôte qui résout vers une IP publique", async () => {
      lookupMock.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
      await expect(validateHttpUrl("http://public.example/")).resolves.toBe("http://public.example/");
    });

    it("signale un échec de résolution DNS", async () => {
      lookupMock.mockRejectedValue(new Error("ENOTFOUND"));
      await expect(validateHttpUrl("http://nonexistent.example/")).rejects.toThrow(
        /DNS resolution failed/
      );
    });
  });
});
