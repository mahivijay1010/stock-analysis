# Global 10–15 day swing candidates — research + screen (2026-10-08)

**Status: UNPROVEN.** This document lists international shares whose *past* behaviour fits "moves a lot day to day, but has been growing steadily, and is not reckless". It is a screen, not a forecast. Nothing in this project has demonstrated stock-picking skill (Evidence tab), and the published record at the 2–4 week horizon is weak short-term *reversal*, not momentum, which mostly vanishes after costs. Every table below should be read as "where to look", never "what will go up".

Window used: 15 trading days from 2026-10-08, ending **2026-10-29**. Anything that reports earnings inside that window is marked as gap risk.

The live version of this list is the **Global swing** tab in Short-term (`GET /api/short-term/global-swing`). It recomputes from Yahoo daily bars and the Finnhub earnings calendar, caches 30 minutes, and ranks 80 names. The tables below are the 2026-10-08 07:07 UTC run plus the web research that fed it.

## 1. Market context (sources dated 7–8 Oct 2026)

| Item | Reading | Source |
|---|---|---|
| S&P 500 / Nasdaq | At or near record highs; S&P ~7,802–7,819 on 7 Oct (sources disagree on the settled print) | TheStreet, Yahoo, Rio Times, 7 Oct |
| VIX | 15.0 — low; implied vol is cheap relative to the event calendar | Rio Times 7 Oct; screen read 15.08 from Yahoo |
| Fed | Hiked 25 bp on 16 Sep 2026 to 3.75–4.00%; one more hike implied by year-end; 10y ~5.29% | federalreserve.gov statement; Schwab; JPM AM |
| Inside the window | 14 Oct CPI · 15 Oct PPI · 13–15 Oct bank earnings · 15 Oct TSMC · 20 Oct NFLX/TSLA · 27–28 Oct FOMC (decision 28 Oct) · 28–29 Oct big-tech earnings | BLS schedule; fedratecalc; ii.co.uk calendar |
| Q3 season | FactSet expects S&P 500 EPS +29% YoY; estimates were *raised* into the season, so beats may be rewarded less | FactSet via jorgai.com |

Read: a 10–15 day hold opened now straddles CPI, the FOMC and the heart of earnings season. The calmest-looking names on the shortlist are the ones that do **not** report before 29 Oct.

## 2. Shortlist from the screen (no earnings inside the window, no hard block, fit ≥ 65)

Fit = trend 30 + 60-day return 20 + ATR-band fit 20 + drawdown control 15 + liquidity 15. "Daily range" is the 20-day ATR as % of price. "Typical 12-day move" is ATR × √12 — the size of a *normal* move either way, not a direction.

| Ticker | Company | Market | Fit | Daily range | Typical 12d move | 60d | Worst 120d DD | Next earnings | Research notes (stockanalysis TTM, 7 Oct) |
|---|---|---|---|---|---|---|---|---|---|
| DE | Deere | US | 90 | 2.6% | ±9% | +12% | −11% | 25 Nov | Research flags **EPS −5.9% TTM**, beta 0.87 — trend is clean but "growth" is not |
| ANET | Arista Networks | US | 89 | 3.3% | ±11% | +18% | −23% | 2 Nov | Rev +33% / EPS +24%; at 52w high |
| PLTR | Palantir | US | 85 | 2.9% | ±10% | +45% | −33% | 2 Nov | Not in the research list; valuation makes it speculative on price action |
| CRM | Salesforce | US | 84 | 3.6% | ±12% | +34% | −28% | 1 Dec (est.) | Rev +11% / EPS +57%; barely above 50-DMA |
| CVX | Chevron | US | 83 | 2.2% | ±7% | +13% | −16% | 30 Oct | One day after the window |
| CRWD | CrowdStrike | US | 83 | 4.6% | ±16% | +26% | −18% | 30 Nov (est.) | Barely GAAP-profitable; wide range — borderline "not risky" |
| AMD | AMD | US | 83 | 3.8% | ±13% | +18% | −26% | 3 Nov | Rev +40% / EPS +125%; +217% over 52w — extended |
| ETN | Eaton | US | 82 | 3.4% | ±12% | +4% | −17% | 3 Nov | Research flags **EPS −1.2% TTM** |
| PANW | Palo Alto Networks | US | 81 | 4.4% | ±15% | +15% | −17% | 17 Nov | Research flags **GAAP EPS −75% TTM** (acquisition accounting); beta 0.93 |
| NVDA | NVIDIA | US | 81 | 2.2% | ±8% | +12% | −19% | 18 Nov | Rev +83% / EPS +125%; beta 2.2 |
| MELI | MercadoLibre | US | 81 | 3.2% | ±11% | 0% | −17% | 4 Nov | Research flags **EPS −9% TTM** and a 28 Oct print in one source — verify the date |
| SHOP | Shopify | US | 81 | 4.0% | ±14% | +32% | −29% | 3 Nov | Not in the research list |
| CEG | Constellation Energy | US | 79 | 4.1% | ±14% | +17% | −27% | 6 Nov | Rev +26% / EPS +8% |
| SIE.DE | Siemens | Europe (IBKR only) | 76 | 2.4% | ±8% | +2% | −11% | 12 Nov | Rev +3.6%; EPS −19% TTM but guidance raised; −3% on 7 Oct |
| V | Visa | US | 75 | 1.5% | ±5% | +5% | −7% | 3 Nov | Quiet: range at the bottom of the band |
| MU | Micron | US | 71 | 4.0% | ±14% | +11% | −39% | 15 Dec (est.) | Rev +256% / EPS +879%; +470% over 52w — parabolic, drawdown −39% |
| AVGO | Broadcom | US | 70 | 2.7% | ±9% | −3% | −30% | 9 Dec (est.) | Rev +49% / EPS +100% |
| DDOG | Datadog | US | 68 | 4.0% | ±14% | 0% | −27% | 5 Nov | Rev +32% / EPS +35%; thin GAAP margin |

**Honest read of the shortlist.** The screen checks price behaviour only; it does not read income statements. Cross-checked against the web research, five of the eighteen (DE, ETN, PANW, MELI, and arguably CRWD) fail a strict "stable growth" test on trailing EPS even though their charts fit. The names that pass *both* the chart screen and the fundamentals research with no earnings in the window are: **ANET, CRM, AMD, NVDA, CEG, AVGO, DDOG, MU** (MU and AMD with the caveat that a 200–470% 52-week run is not "not risky"), plus **CVX** if a 30 Oct print one day after the window is acceptable. That is the comprehensive answer to "which fit": eight to nine names, not eighteen.

## 3. Good fit on the chart but earnings fall inside the window (gap risk)

| Ticker | Company | Fit | Daily range | 60d | Earnings | Note |
|---|---|---|---|---|---|---|
| 6501.T | Hitachi | 63 | 2.3% | +18% | 28 Oct (manual) | Rev +12% / EPS +28%; Tokyo only |
| XOM | ExxonMobil | 59 | 2.2% | +13% | 23 Oct | |
| MSFT | Microsoft | 59 | 2.2% | +38% | 27 Oct | |
| LLY | Eli Lilly | 58 | 2.6% | +3% | 29 Oct | Beta 0.45 — too quiet anyway |
| META | Meta | 56 | 3.6% | +9% | 28 Oct | Research flags EPS −3.7% TTM |
| TSM | TSMC (ADR) | 55 | 2.2% | +12% | **14–15 Oct** | Rev +31% / EPS +53%; the cleanest fundamentals on the list, but the print is next week |
| AAPL | Apple | 54 | 1.9% | +7% | 29 Oct | |
| SAP | SAP (ADR) | 54 | 2.3% | +36% | 21 Oct | Beta 0.76 |
| 6857.T | Advantest | 53 | 4.3% | +40% | 28 Oct (manual) | Rev +36% / EPS +104%; Tokyo only |
| NOW | ServiceNow | 53 | 4.0% | +32% | 28 Oct | EPS flat TTM |
| ASML | ASML (ADR) | 53 | 2.7% | +2% | **14 Oct** | Same morning as CPI |
| PWR | Quanta Services | 53 | 3.3% | +6% | 29 Oct | Rev +26% / EPS +36% |
| AMZN | Amazon | 51 | 2.1% | +5% | 29 Oct | |
| GOOGL | Alphabet | 48 | 2.5% | −3% | 27 Oct | |

These become candidates for a window that **opens after their print**, if the post-earnings behaviour still fits. Do not hold a 10–15 day position through a report you have not deliberately chosen to hold through.

## 4. Non-US names reviewed and why most were excluded

From the international research pass (stockanalysis, investing.com, company IR; 7–8 Oct 2026):

| Company | Listing | Screen verdict | Reason |
|---|---|---|---|
| Tokyo Electron | 8035.T | WATCH (59) | −14% over 60d, −37% drawdown; earnings 30 Oct |
| Tencent | 0700.HK / TCEHY | AVOID | Below both averages; at 52w low despite Rev +12% / EPS +14% |
| Samsung Electronics | 005930.KS | AVOID (block) | −43% drawdown inside 120d; earnings 28–29 Oct; no usable US line |
| SK Hynix | 000660.KS | AVOID (block) | −55% drawdown; beta 2.4; earnings 27–29 Oct |
| SoftBank Group | 9984.T | AVOID (block) | ATR 6.5%/day — too wild |
| Infineon | IFX.DE | WATCH (52) | −39% drawdown; 4–9% daily moves |
| Rheinmetall | RHM.DE | AVOID | −50% over 1 year; at 52w low |
| LVMH, Hermès, Nestlé, BYD, Xiaomi, Alibaba, Meituan, Hyundai | various | AVOID | Negative trailing revenue or EPS growth, or unprofitable; several also below both averages |
| Novo Nordisk | NVO | AVOID | Below both averages, −22% over 60d; beta 0.34 |
| Toyota, TotalEnergies, Rio Tinto | TM, TTE, RIO | AVOID | Too quiet or below 50-DMA |
| Sony | SONY | WATCH (60) | Below 50-DMA; TTM EPS line looks one-off — unverified |
| Schneider Electric | SU.PA | AVOID | Below both averages after −7% on the PTC deal day |

Honest summary: **outside the US, almost nothing currently fits.** Asian semis have the growth but are either in deep drawdowns or report inside the window; European quality names are mostly in downtrends. Siemens and Hitachi are the two that come closest.

## 5. Lower-risk alternatives (US-listed ETFs; 30-day realised vol, AlphaQuery 7 Oct)

| ETF | Exposure | 30d vol | Read |
|---|---|---|---|
| SMH / SOXX | Semiconductors | 30% / 36% | As volatile as the single names, with less idiosyncratic earnings risk |
| EWY | Korea | 45% | *More* volatile than most single stocks here |
| XLK / QQQ | US tech / Nasdaq-100 | 17% / 15% | The genuinely calmer version of the shortlist |
| EWJ / FXI / EFA | Japan / China / developed ex-US | 18% / 19% / 13% | Diversified routes to markets Indian brokers do not reach directly |

## 6. What it costs an Indian resident (Oct 2026; verify before remitting)

- **Access.** Vested, INDmoney, Rovia, Groww (GIFT City, live) give NYSE/Nasdaq only; INDmoney also OTC ADRs. Only **Interactive Brokers** (or Paasa on top of it) reaches Euronext, Xetra, Tokyo, Hong Kong, Korea, Taiwan directly. Zerodha/Upstox GIFT City access is approved but go-live status is unverified. The old NSE IFSC receipts programme was terminated by circular of 24 Jul 2026.
- **LRS.** $250,000 per person per FY. **TCS** is 0% up to ₹10 lakh aggregate LRS per FY, then **20%** above it for investments — creditable against tax, but cash locked until the refund. On a ₹5 lakh remittance that takes you to ₹15 lakh, ₹1 lakh sits idle for months. For a 10–15 day trade this is the biggest cash drag.
- **Tax.** Foreign shares are "unlisted" for Indian tax: held ≤ 24 months → **slab rate** (up to 30% + cess). LTCG only after 24 months at 12.5%. Every swing here is slab-rate STCG. US dividends suffer 25% withholding (DTAA credit via Form 67). Report in ITR-2 Schedule FA/FSI.
- **Round trip.** Vested/INDmoney type: FX markup 0.9–1.2% each way + brokerage ≈ **2.0–2.6%** before tax. IBKR: ≈ 0.1–0.4% plus whatever your bank charges on the outward wire (often 0.5–1.5% unless negotiated). The app's cost line uses **1.3%** as a mid scenario.
- **Arithmetic.** A "typical" ±9% 12-day move on NVDA, at a 2% round-trip cost and 30% slab, nets about 4.9% if it goes the right way and −11% if it goes the wrong way with the stop at 2×ATR (−4.4%) plus costs. The cost does not kill the trade the way it does for sub-₹100 NSE names (14–21 bps per side there vs 1% here on a 10× larger move), but there is still no demonstrated edge in picking the direction.

## 7. What was NOT verified

- ATR% and 50/200-DMA status came from the screen's own Yahoo bars, not from a second source. Web research could not obtain ATR from any page.
- Earnings dates for AVGO, MU, MRVL, CRM, CRWD, ORCL are MarketBeat *estimates*; all fall in December so the window verdict holds within ±1 week. Dates for Tokyo/Frankfurt/Hong Kong/Korea listings are manual (research dated 2026-10-08) and labelled "manual date, verify" in the app.
- MELI's earnings date disagrees between sources (28 Oct vs 4 Nov). Alibaba's HK price disagreed between two sources. Sony's negative TTM EPS looks like a one-off.
- Trailing growth figures are stockanalysis TTM reads, not checked against filings.
- The screen has **zero graded forward outcomes**. A hit rate will be shown only after ten graded outcomes, per the project's honesty conventions.

## 8. Sources

US names: stockanalysis.com/stocks/{ticker}/ and /statistics/ (7 Oct closes); marketbeat.com earnings pages; investor.tsmc.com/english/financial-calendar; SEC 8-K for TSLA (21 Oct); ii.co.uk US earnings calendar; jorgai.com Q3 2026 season dates; financecalendar.com. Macro: bls.gov release schedule; fedratecalc.com FOMC October 2026; federalreserve.gov monetary20260916a1.pdf; schwab.com FOMC; am.jpmorgan.com FOMC statement Sept 2026; thestreet.com, finance.yahoo.com, riotimesonline.com 7 Oct market wraps.
Non-US names: stockanalysis.com/quote/{ams,fra,epa,tyo,hkg,krx,tpe,swx}/…; investing.com; lvmh.com financial calendar; ad-hoc-news.de (Novo, Schneider); 247wallst.com (SK Hynix 6 Oct); seekingalpha.com TSMC preview.
ETFs: alphaquery.com 30-day historical volatility pages; streetstats.finance (VIX).
India access and tax: vested.blog (platform comparison Jul 2026; IBKR guide; capital-gains guide); paasa.com; business-standard.com and businesstoday.in (GIFT City approvals, 16–17 Jun 2026); whalesbook.com (Groww go-live); NSE IFSC circular TRADE/2698 (24 Jul 2026); xflowpay.com, razorpay.com (LRS); bookmyforex.com, agrawalkhandelwal.com, wise.com (TCS FY2026-27); cleartax.in, winvesta.in, motilaloswal.com (Aug 2026), upstox.com, finnovate.in (tax, GIFT City).
