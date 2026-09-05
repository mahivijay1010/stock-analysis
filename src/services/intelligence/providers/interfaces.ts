import { FilingDocument, MacroValue } from "../types";

export interface FinancialDataProvider {
  readonly name: string;
  listFinancialFilings(ticker: string, years?: number): Promise<FilingDocument[]>;
  downloadStructuredFiling(filing: FilingDocument): Promise<{ xml: string; contentHash: string; cachePath: string }>;
}

export interface CorporateFilingProvider {
  readonly name: string;
  listAnnouncements(ticker: string, from: Date, to: Date): Promise<FilingDocument[]>;
  listAnnualReports?(ticker: string): Promise<FilingDocument[]>;
}

export interface MacroDataProvider {
  readonly name: string;
  fetchCurrent(): Promise<MacroValue[]>;
}

export interface DocumentProvider {
  readonly name: string;
  discover(ticker: string, pageUrl: string): Promise<FilingDocument[]>;
  extractText(document: FilingDocument): Promise<{ text: string; contentHash: string; cachePath: string }>;
}

export interface BseFinancialSummary {
  bseCode: string;
  period: string;
  revenue: number | null;
  netIncome: number | null;
  eps: number | null;
  sourceUrl: string;
  raw: Record<string, unknown>;
}
