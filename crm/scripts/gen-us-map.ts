/**
 * Regenerate `src/lib/usMap.ts` — the state outlines the Licensing map draws.
 *
 *   npx tsx scripts/gen-us-map.ts
 *
 * ## Why a generator and not a dependency
 *
 * Drawing a real map needs real geometry, and there are only three ways to
 * get it: ship a mapping library and project at runtime, hand-write fifty
 * path strings (which produces a map that is wrong in ways nobody can
 * review), or derive it once from a canonical source and commit the result.
 *
 * This is the third. `us-atlas` is the Observable/D3 project's TopoJSON of
 * the Census Bureau's own boundaries, and its `-albers-` builds are already
 * projected into a ~975×610 viewport — so the output is plain `<path d="…">`
 * with no projection maths, no `d3-geo`, no `topojson-client`, and nothing
 * added to the app bundle but the strings themselves.
 *
 * ## Why the source isn't committed
 *
 * The 82KB TopoJSON is an input, not an artefact: keeping it would double
 * what the repo carries to say the same thing twice. The generated file
 * records the exact URL and the resolution, so a regeneration is one command
 * and produces a reviewable diff rather than a mystery blob.
 *
 * Attribution: us-atlas is ISC-licensed, from public-domain Census data.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SOURCE = "https://cdn.jsdelivr.net/npm/us-atlas@3/states-albers-10m.json";

/**
 * Coordinates are rounded to this many decimals.
 *
 * The map is drawn about 900px wide in a ~1015-unit viewBox, so a tenth of a
 * unit is well under a rendered pixel — and rounding is most of why the
 * output is a third of the size the raw floats would be.
 */
const PRECISION = 1;

/**
 * Douglas–Peucker tolerance, in the same units — about a third of a rendered
 * pixel. Halves the output for no visible change to any border.
 *
 * Applied to **arcs, before stitching**, which is the only place it is safe.
 * A shared border between two states is one arc referenced twice, so
 * simplifying it once keeps both sides on the identical line; simplifying the
 * finished rings instead would thin the same border differently for each
 * state and open hairline gaps between them.
 */
const SIMPLIFY = 0.35;

/** Census FIPS → USPS, the code every `License.state` is written in. */
const FIPS_TO_USPS: Record<string, string> = {
  "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO",
  "09": "CT", "10": "DE", "11": "DC", "12": "FL", "13": "GA", "15": "HI",
  "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY",
  "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN",
  "28": "MS", "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH",
  "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH",
  "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD",
  "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA",
  "54": "WV", "55": "WI", "56": "WY",
};

interface Topology {
  bbox: [number, number, number, number];
  transform: { scale: [number, number]; translate: [number, number] };
  arcs: [number, number][][];
  objects: {
    states: {
      geometries: {
        type: "Polygon" | "MultiPolygon";
        id: string;
        properties: { name: string };
        arcs: number[][] | number[][][];
      }[];
    };
  };
}

const round = (n: number) => Number(n.toFixed(PRECISION));

/** Perpendicular distance from `p` to the segment `a`–`b`. */
function segmentDistance(
  p: [number, number],
  a: [number, number],
  b: [number, number]
): number {
  const [px, py] = p;
  const [ax, ay] = a;
  const dx = b[0] - ax;
  const dy = b[1] - ay;
  if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(
    0,
    Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))
  );
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Douglas–Peucker. Endpoints are always kept, which is what lets adjacent
 *  arcs stay joined. */
function simplify(pts: [number, number][], tol: number): [number, number][] {
  if (pts.length < 3) return pts;
  let worst = 0;
  let idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = segmentDistance(pts[i], pts[0], pts[pts.length - 1]);
    if (d > worst) {
      worst = d;
      idx = i;
    }
  }
  if (worst <= tol) return [pts[0], pts[pts.length - 1]];
  return [
    ...simplify(pts.slice(0, idx + 1), tol).slice(0, -1),
    ...simplify(pts.slice(idx), tol),
  ];
}

/** TopoJSON stores arcs delta-encoded against a shared quantisation grid. */
function decodeArcs(topo: Topology): [number, number][][] {
  const [sx, sy] = topo.transform.scale;
  const [tx, ty] = topo.transform.translate;
  return topo.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => {
      x += dx;
      y += dy;
      return [x * sx + tx, y * sy + ty] as [number, number];
    });
  });
}

/**
 * Stitch a ring's arc indices into one point list.
 *
 * A negative index means "this arc, reversed" and is encoded as `~i` — the
 * mechanism that lets two states share one border line rather than each
 * carrying its own copy of it.
 */
function ringPoints(
  arcs: [number, number][][],
  indices: number[]
): [number, number][] {
  const pts: [number, number][] = [];
  for (const i of indices) {
    const arc = i >= 0 ? arcs[i] : [...arcs[~i]].reverse();
    // The shared endpoint is already the last point of the previous arc.
    pts.push(...(pts.length ? arc.slice(1) : arc));
  }
  return pts;
}

const ringPath = (pts: [number, number][]) =>
  pts
    .map(([x, y], i) => `${i ? "L" : "M"}${round(x)},${round(y)}`)
    .join("") + "Z";

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`${SOURCE} → HTTP ${res.status}`);
const topo = (await res.json()) as Topology;

const rawArcs = decodeArcs(topo);
const arcs = rawArcs.map((a) => simplify(a, SIMPLIFY));
const paths: Record<string, string> = {};
const named: Record<string, string> = {};

for (const g of topo.objects.states.geometries) {
  const code = FIPS_TO_USPS[g.id];
  if (!code) throw new Error(`No USPS code for FIPS ${g.id} (${g.properties.name})`);
  const polygons = (g.type === "Polygon" ? [g.arcs] : g.arcs) as number[][][];
  paths[code] = polygons
    .flatMap((rings) => rings.map((r) => ringPath(ringPoints(arcs, r))))
    .join("");
  named[code] = g.properties.name;
}

const missing = Object.values(FIPS_TO_USPS).filter((c) => !paths[c]);
if (missing.length) throw new Error(`No geometry for ${missing.join(", ")}`);

// From the min corner, not from the origin. The Albers USA composite places
// the Aleutian chain to the LEFT of x=0 (the source bbox starts at ≈ -57.7),
// so a `0 0 …` viewBox — the one every us-atlas example uses — silently
// crops the tail off Alaska.
//
// Width and height are measured from the *rounded* origin, not from the raw
// one. Rounding the origin down and the span up independently loses the
// fraction between them: with y0 = 12.98 → 12 and a span of ceil(593.59) =
// 594, the box ends at 606 while Florida reaches 606.57, and the southern tip
// is quietly shaved off.
const [x0, y0, x1, y1] = topo.bbox;
const minX = Math.floor(x0);
const minY = Math.floor(y0);
const viewBox = [
  minX,
  minY,
  Math.ceil(x1) - minX,
  Math.ceil(y1) - minY,
].join(" ");

const out = `// GENERATED by scripts/gen-us-map.ts — do not edit by hand.
// Source: ${SOURCE}
// (us-atlas, ISC licence, from public-domain US Census boundaries; the
// -albers- build is pre-projected, so these are screen coordinates already.)
//
// Regenerate with:  npx tsx scripts/gen-us-map.ts

/** The viewBox these paths are drawn in. */
export const US_MAP_VIEWBOX = ${JSON.stringify(viewBox)};

/** USPS code → SVG path data for that state's outline. */
export const US_STATE_PATHS: Readonly<Record<string, string>> = Object.freeze({
${Object.keys(paths)
  .sort()
  .map((c) => `  ${c}: ${JSON.stringify(paths[c])},`)
  .join("\n")}
});

/** USPS code → the state's full name, for labels and titles. */
export const US_STATE_NAMES: Readonly<Record<string, string>> = Object.freeze({
${Object.keys(named)
  .sort()
  .map((c) => `  ${c}: ${JSON.stringify(named[c])},`)
  .join("\n")}
});
`;

const target = resolve(process.cwd(), "src/lib/usMap.ts");
writeFileSync(target, out);
console.log(
  `Wrote ${target} — ${Object.keys(paths).length} states, ${(out.length / 1024).toFixed(0)}KB, viewBox ${viewBox}`
);
