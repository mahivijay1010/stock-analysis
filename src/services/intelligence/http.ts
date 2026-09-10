import axios, { AxiosError, AxiosRequestConfig } from "axios";
import { assertUrlAllowed } from "./ssrfGuard";

export interface HttpResponse<T> {
  data: T;
  contentType: string | null;
  headers: Record<string, string | string[] | undefined>;
  url: string;
}

const MAX_RESPONSE_BYTES = 25 * 1024 * 1024; // hard cap — resource-exhaustion defense (#10)
const MAX_REDIRECTS = 5;

export class ResilientHttpClient {
  private lastRequestAt = 0;

  constructor(
    private readonly allowedHosts: string[],
    private readonly minIntervalMs = 250,
    private readonly timeoutMs = 20_000
  ) {}

  async getText(url: string, config: AxiosRequestConfig = {}): Promise<HttpResponse<string>> {
    const response = await this.get<ArrayBuffer | string>(url, { ...config, responseType: "text" });
    return { ...response, data: typeof response.data === "string" ? response.data : String(response.data) };
  }

  async getJson<T>(url: string, config: AxiosRequestConfig = {}): Promise<HttpResponse<T>> {
    return this.get<T>(url, { ...config, responseType: "json" });
  }

  async getBuffer(url: string, config: AxiosRequestConfig = {}): Promise<HttpResponse<Buffer>> {
    const response = await this.get<ArrayBuffer>(url, { ...config, responseType: "arraybuffer" });
    return { ...response, data: Buffer.from(response.data) };
  }

  private async get<T>(url: string, config: AxiosRequestConfig): Promise<HttpResponse<T>> {
    const policy = { allowedHosts: this.allowedHosts, maxBytes: MAX_RESPONSE_BYTES };
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const wait = this.minIntervalMs - (Date.now() - this.lastRequestAt);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      this.lastRequestAt = Date.now();
      try {
        // Follow redirects MANUALLY so every hop is SSRF-revalidated (host
        // allowlist + non-private DNS). axios' own redirects would bypass the
        // per-hop check (#10).
        let currentUrl = url;
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
          await assertUrlAllowed(currentUrl, policy);
          const result = await axios.get<T>(currentUrl, {
            ...config,
            timeout: this.timeoutMs,
            maxRedirects: 0, // no auto-follow — we revalidate each hop ourselves
            maxContentLength: MAX_RESPONSE_BYTES,
            maxBodyLength: MAX_RESPONSE_BYTES,
            validateStatus: (status) => (status >= 200 && status < 300) || (status >= 300 && status < 400),
            headers: {
              "User-Agent": "StockIntelligenceEngine/1.0 (+per-company public-data retrieval)",
              Accept: "application/json,text/csv,application/xml,text/xml,text/html,application/pdf,*/*",
              ...config.headers,
            },
          });
          if (result.status >= 300 && result.status < 400) {
            const location = result.headers["location"];
            if (typeof location !== "string" || !location) throw new Error(`Redirect ${result.status} without a Location header`);
            if (hop === MAX_REDIRECTS) throw new Error(`Too many redirects (>${MAX_REDIRECTS}) starting from ${url}`);
            currentUrl = new URL(location, currentUrl).toString(); // resolve relative, revalidated next loop
            continue;
          }
          return {
            data: result.data,
            contentType: typeof result.headers["content-type"] === "string" ? result.headers["content-type"] : null,
            headers: result.headers as Record<string, string | string[] | undefined>,
            url: currentUrl,
          };
        }
        throw new Error("redirect loop exhausted"); // unreachable
      } catch (error) {
        lastError = error;
        // A blocked-host / private-IP rejection is terminal — never retry it.
        if (error instanceof Error && error.message.startsWith("Blocked")) throw error;
        const status = (error as AxiosError).response?.status;
        if (attempt === 2 || (status != null && status < 500 && status !== 429)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500 * Math.pow(2, attempt)));
      }
    }
    throw lastError;
  }
}
