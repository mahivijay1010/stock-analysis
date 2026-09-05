import axios, { AxiosError, AxiosRequestConfig } from "axios";

export interface HttpResponse<T> {
  data: T;
  contentType: string | null;
  headers: Record<string, string | string[] | undefined>;
  url: string;
}

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
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !this.allowedHosts.some((h) => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`))) {
      throw new Error(`Blocked unapproved data-source host: ${parsed.hostname}`);
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const wait = this.minIntervalMs - (Date.now() - this.lastRequestAt);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      this.lastRequestAt = Date.now();
      try {
        const result = await axios.get<T>(url, {
          ...config,
          timeout: this.timeoutMs,
          maxRedirects: 5,
          validateStatus: (status) => status >= 200 && status < 300,
          headers: {
            "User-Agent": "StockIntelligenceEngine/1.0 (+per-company public-data retrieval)",
            Accept: "application/json,text/csv,application/xml,text/xml,text/html,application/pdf,*/*",
            ...config.headers,
          },
        });
        return {
          data: result.data,
          contentType: typeof result.headers["content-type"] === "string" ? result.headers["content-type"] : null,
          headers: result.headers as Record<string, string | string[] | undefined>,
          url: result.request?.res?.responseUrl ?? url,
        };
      } catch (error) {
        lastError = error;
        const status = (error as AxiosError).response?.status;
        if (attempt === 2 || (status != null && status < 500 && status !== 429)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500 * Math.pow(2, attempt)));
      }
    }
    throw lastError;
  }
}
