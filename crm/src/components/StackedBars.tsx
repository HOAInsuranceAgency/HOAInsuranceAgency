export interface ChartSeries { key: string; label: string; color?: string }
export interface ChartRow { key: string; label: string; values: Record<string, number> }

const COLORS = ['#2469a5', '#168071', '#7859aa', '#bd6a20', '#b74765', '#52699d', '#62852a', '#99663d'];
function seriesColor(series: ChartSeries): string {
  let hash = 0;
  for (const character of series.key) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return series.color ?? COLORS[(hash >>> 0) % COLORS.length];
}

/** Every bar exposes exact values to keyboard, touch and screen-reader users.
 * The optional table also makes small segments legible without relying on color. */
export function StackedBars({ label, rows, series, formatValue = value => value.toLocaleString(), vertical = false, maxValue }: {
  label: string;
  rows: ChartRow[];
  series: ChartSeries[];
  formatValue?: (value: number) => string;
  vertical?: boolean;
  maxValue?: number;
}) {
  const totals = rows.map(row => series.reduce((sum, item) => sum + (row.values[item.key] ?? 0), 0));
  const positiveMax = Math.max(1, maxValue ?? 0, ...rows.map(row => series.reduce((sum, item) => sum + Math.max(0, row.values[item.key] ?? 0), 0)));
  const negativeMax = Math.max(0, ...rows.map(row => series.reduce((sum, item) => sum + Math.max(0, -(row.values[item.key] ?? 0)), 0)));
  const extent = positiveMax + negativeMax;
  return <div className="sales-chart" role="group" aria-label={label}>
    {!rows.length ? <p className="muted small">No data for this period.</p> : <>
      <div className={vertical ? 'sales-chart-scroll' : undefined}>
        <div className={vertical ? 'sales-chart-bars vertical' : 'sales-chart-bars'}>
          {rows.map((row, index) => {
            let positive = negativeMax, negative = negativeMax;
            const detail = series.filter(item => row.values[item.key]).map(item => `${item.label}: ${formatValue(row.values[item.key])}`).join('; ');
            return <div className="sales-chart-row" key={row.key}>
              <span className="sales-chart-label" title={row.label}>{row.label}</span>
              <div className="sales-chart-track" tabIndex={0} role="img" aria-label={`${row.label}: ${formatValue(totals[index])}${detail ? `. ${detail}` : ''}`} title={`${row.label}: ${formatValue(totals[index])}${detail ? `\n${detail}` : ''}`}>
                {series.map(item => {
                  const amount = row.values[item.key] ?? 0;
                  const start = amount >= 0 ? positive : negative + amount;
                  if (amount >= 0) positive += amount; else negative += amount;
                  return amount !== 0 && <span key={item.key} className="sales-chart-segment" style={{ backgroundColor: seriesColor(item), [vertical ? 'bottom' : 'left']: `${start / extent * 100}%`, [vertical ? 'height' : 'width']: `${Math.abs(amount) / extent * 100}%` }} />;
                })}
                {negativeMax > 0 && <span className="sales-chart-zero" style={{ [vertical ? 'bottom' : 'left']: `${negativeMax / extent * 100}%` }} />}
              </div>
              <span className="sales-chart-value">{formatValue(totals[index])}</span>
            </div>;
          })}
        </div>
      </div>
      <div className="sales-chart-legend" aria-label={`${label} legend`}>
        {series.map(item => <span key={item.key}><i style={{ backgroundColor: seriesColor(item) }} aria-hidden="true" />{item.label}</span>)}
      </div>
      <details className="sales-chart-details"><summary>View chart values</summary>
        <div className="table-wrap"><table><caption className="sr-only">{label}</caption><thead><tr><th scope="col">Category</th>{series.map(item => <th scope="col" key={item.key}>{item.label}</th>)}<th scope="col">Total</th></tr></thead>
          <tbody>{rows.map((row, index) => <tr key={row.key}><th scope="row">{row.label}</th>{series.map(item => <td key={item.key}>{formatValue(row.values[item.key] ?? 0)}</td>)}<td>{formatValue(totals[index])}</td></tr>)}</tbody>
        </table></div>
      </details>
    </>}
  </div>;
}
