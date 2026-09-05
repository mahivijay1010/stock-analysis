export const SOURCE_REGISTRY = [
  { priority: 1, provider: "NSE", data: "financial-result XBRL, integrated filings, annual reports, announcements", mode: "public per-company endpoints", bulkAccess: "licensed NSE corporate-data subscription", officialUrl: "https://www.nseindia.com/companies-listing/corporate-filings-financial-results" },
  { priority: 1, provider: "BSE", data: "company results and announcements", mode: "public per-company endpoints", officialUrl: "https://www.bseindia.com/corporates/results.aspx" },
  { priority: 1, provider: "RBI", data: "policy rates and configured official downloadable series", mode: "official HTML/downloads", officialUrl: "https://m.rbi.org.in/home.aspx" },
  { priority: 1, provider: "MoSPI", data: "CPI API and configured official CPI/GDP/IIP downloads", mode: "official API/eSankhyiki", officialUrl: "https://api.mospi.gov.in" },
  { priority: 2, provider: "COMPANY_IR", data: "annual reports and investor presentations", mode: "official IR page supplied by caller; cached PDF extraction" },
  { priority: 4, provider: "Yahoo Finance", data: "market price, market cap, trailing PE", mode: "secondary market-data fallback; never overrides filings" },
  { priority: 5, provider: "CALCULATED", data: "ROE, ROIC, FCF, growth, PEG, DCF, portfolio exposure/correlation", mode: "formula plus full input/source lineage" },
] as const;
