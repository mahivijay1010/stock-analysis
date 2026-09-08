import { fetchChart } from "../src/services/market/yahoo";
(async () => {
  const { bars, events } = await fetchChart("RELIANCE.NS", "2y");
  const withAdj = bars.filter((b) => b.adjustedClose != null).length;
  const last = bars[bars.length - 1];
  console.log(`bars=${bars.length} withAdjusted=${withAdj}`);
  console.log(`last: ${last.date} close=${last.close} adj=${last.adjustedClose}`);
  const first = bars[0];
  console.log(`first: ${first.date} close=${first.close} adj=${first.adjustedClose} (divergence = dividends)`);
  console.log(`events: splits=${JSON.stringify(events.splits)} dividends=${JSON.stringify(events.dividends)}`);
})();
