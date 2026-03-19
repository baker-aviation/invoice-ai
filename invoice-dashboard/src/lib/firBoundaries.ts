/**
 * Simplified FIR (Flight Information Region) boundary dataset.
 *
 * Covers regions Baker Aviation operates through: US, Canada, Mexico,
 * Central America, Caribbean, and northern South America.
 *
 * Boundaries are approximate polygons — accurate enough for great-circle
 * overflight detection, NOT for ATC filing or survey work.
 */

// GeoJSON types — use the global GeoJSON namespace (included via @types/geojson
// which @turf/turf pulls in)
type Polygon = GeoJSON.Polygon;
type FeatureCollection<G extends GeoJSON.Geometry = GeoJSON.Geometry, P = GeoJSON.GeoJsonProperties> = GeoJSON.FeatureCollection<G, P>;

export type FIRProperties = {
  fir_id: string;
  country_name: string;
  country_iso: string;
};

function fir(
  fir_id: string,
  country_name: string,
  country_iso: string,
  ring: [number, number][]
): GeoJSON.Feature<Polygon, FIRProperties> {
  return {
    type: "Feature",
    properties: { fir_id, country_name, country_iso },
    geometry: {
      type: "Polygon",
      // GeoJSON polygons must close — ensure the first point repeats at end
      coordinates: [ring[ring.length - 1][0] === ring[0][0] && ring[ring.length - 1][1] === ring[0][1] ? ring : [...ring, ring[0]]],
    },
  };
}

/**
 * All coordinates are [longitude, latitude] per GeoJSON spec.
 */
export const firBoundaries: FeatureCollection<Polygon, FIRProperties> = {
  type: "FeatureCollection",
  features: [
    // ─── United States ─────────────────────────────────────────────
    // Simplified CONUS + Alaska combined — large bounding polygon
    fir("KZWY", "United States", "US", [
      [-130, 49],
      [-67, 49],
      [-67, 44],
      [-66, 43],
      [-67, 40],
      [-74, 38],
      [-75, 35],
      [-80, 32],
      [-81, 30],
      [-80, 25],
      [-82, 24.5],
      [-87, 29],
      [-89, 28],
      [-94, 29],
      [-97, 26],
      [-104, 32],
      [-117, 32],
      [-124, 40],
      [-125, 48],
      [-130, 49],
    ]),

    // US Oceanic (New York Oceanic / KZWY) — covers Bermuda area too
    fir("KZWY_OCEANIC", "United States", "US", [
      [-67, 49],
      [-40, 49],
      [-40, 30],
      [-55, 20],
      [-67, 20],
      [-67, 40],
      [-67, 49],
    ]),

    // ─── Canada ────────────────────────────────────────────────────
    // Moncton FIR (eastern)
    fir("CZQM", "Canada", "CA", [
      [-75, 49],
      [-53, 49],
      [-53, 43],
      [-60, 43],
      [-67, 44],
      [-67, 49],
      [-75, 49],
    ]),
    // Montreal FIR
    fir("CZUL", "Canada", "CA", [
      [-80, 53],
      [-67, 53],
      [-67, 49],
      [-75, 49],
      [-80, 49],
      [-80, 53],
    ]),
    // Toronto FIR
    fir("CZYZ", "Canada", "CA", [
      [-90, 53],
      [-80, 53],
      [-80, 49],
      [-83, 46],
      [-90, 49],
      [-90, 53],
    ]),
    // Winnipeg FIR
    fir("CZWG", "Canada", "CA", [
      [-102, 60],
      [-88, 60],
      [-88, 49],
      [-102, 49],
      [-102, 60],
    ]),
    // Edmonton FIR
    fir("CZEG", "Canada", "CA", [
      [-120, 60],
      [-102, 60],
      [-102, 49],
      [-120, 49],
      [-120, 60],
    ]),
    // Vancouver FIR
    fir("CZVR", "Canada", "CA", [
      [-141, 60],
      [-120, 60],
      [-120, 49],
      [-130, 49],
      [-141, 55],
      [-141, 60],
    ]),

    // ─── Mexico ────────────────────────────────────────────────────
    // Mexico City FIR
    fir("MMFR", "Mexico", "MX", [
      [-104, 24],
      [-97, 26],
      [-94, 22],
      [-92, 18],
      [-96, 15.5],
      [-105, 19],
      [-106, 22],
      [-104, 24],
    ]),
    // Merida FIR
    fir("MMMD", "Mexico", "MX", [
      [-94, 22],
      [-87, 22],
      [-87, 18],
      [-89, 15],
      [-92, 15],
      [-92, 18],
      [-94, 22],
    ]),
    // Monterrey FIR
    fir("MMTY", "Mexico", "MX", [
      [-117, 32],
      [-104, 32],
      [-104, 24],
      [-106, 22],
      [-105, 19],
      [-117, 25],
      [-117, 32],
    ]),
    // Mazatlan FIR (Pacific coast)
    fir("MMZT", "Mexico", "MX", [
      [-117, 25],
      [-105, 19],
      [-96, 15.5],
      [-105, 10],
      [-118, 20],
      [-117, 25],
    ]),

    // ─── Cuba ──────────────────────────────────────────────────────
    fir("MUHG", "Cuba", "CU", [
      [-85, 23.5],
      [-74, 23.5],
      [-74, 19.5],
      [-78, 18],
      [-85, 19.5],
      [-85, 23.5],
    ]),

    // ─── Jamaica ───────────────────────────────────────────────────
    fir("MKJK", "Jamaica", "JM", [
      [-78, 18],
      [-74, 19.5],
      [-74, 17],
      [-78, 17],
      [-78, 18],
    ]),

    // ─── Bahamas (Nassau FIR) ──────────────────────────────────────
    fir("MYNA", "Bahamas", "BS", [
      [-80, 27.5],
      [-74, 27.5],
      [-74, 23.5],
      [-77, 21],
      [-80, 22],
      [-80, 25],
      [-80, 27.5],
    ]),

    // ─── Dominican Republic (Santo Domingo FIR) ────────────────────
    fir("MDCS", "Dominican Republic", "DO", [
      [-74, 21],
      [-67, 21],
      [-67, 17.5],
      [-74, 17.5],
      [-74, 19.5],
      [-74, 21],
    ]),

    // ─── Haiti (Port-au-Prince FIR) ───────────────────────────────
    fir("MTEG", "Haiti", "HT", [
      [-74.5, 20.5],
      [-71.5, 20.5],
      [-71.5, 18],
      [-74.5, 18],
      [-74.5, 20.5],
    ]),

    // ─── Guatemala ─────────────────────────────────────────────────
    fir("MGGT", "Guatemala", "GT", [
      [-92, 18],
      [-89, 18],
      [-88.5, 16],
      [-89, 14.5],
      [-92, 14],
      [-92, 18],
    ]),

    // ─── Honduras / Central American FIR ───────────────────────────
    fir("MHTG", "Honduras", "HN", [
      [-89, 18],
      [-83, 18],
      [-83, 13],
      [-89, 13],
      [-89, 14.5],
      [-88.5, 16],
      [-89, 18],
    ]),

    // ─── Nicaragua (Managua FIR) ───────────────────────────────────
    fir("MNMG", "Nicaragua", "NI", [
      [-87, 15],
      [-83, 15],
      [-83, 11],
      [-87, 11],
      [-87, 15],
    ]),

    // ─── Costa Rica ────────────────────────────────────────────────
    fir("MROC", "Costa Rica", "CR", [
      [-87, 11],
      [-83, 11],
      [-82.5, 8],
      [-87, 8],
      [-87, 11],
    ]),

    // ─── Panama ────────────────────────────────────────────────────
    fir("MPZL", "Panama", "PA", [
      [-83, 10],
      [-77, 10],
      [-77, 7],
      [-83, 7],
      [-82.5, 8],
      [-83, 10],
    ]),

    // ─── Colombia (Barranquilla FIR — northern) ────────────────────
    fir("SKEC", "Colombia", "CO", [
      [-77, 13],
      [-70, 13],
      [-70, 7],
      [-77, 7],
      [-77, 10],
      [-77, 13],
    ]),

    // ─── Colombia (Bogota FIR — central/south) ─────────────────────
    fir("SKED", "Colombia", "CO", [
      [-77, 7],
      [-67, 7],
      [-67, 0],
      [-77, 0],
      [-77, 7],
    ]),

    // ─── Venezuela ─────────────────────────────────────────────────
    fir("SVZM", "Venezuela", "VE", [
      [-70, 13],
      [-60, 13],
      [-60, 1],
      [-67, 1],
      [-67, 7],
      [-70, 7],
      [-70, 13],
    ]),

    // ─── Belize ────────────────────────────────────────────────────
    fir("MZBZ", "Belize", "BZ", [
      [-89.5, 18.5],
      [-87.5, 18.5],
      [-87.5, 15.8],
      [-89, 15.8],
      [-89.5, 18.5],
    ]),

    // ─── El Salvador ───────────────────────────────────────────────
    fir("MSLP", "El Salvador", "SV", [
      [-90.2, 14.5],
      [-87.5, 14.5],
      [-87.5, 13],
      [-90.2, 13],
      [-90.2, 14.5],
    ]),

    // ─── Puerto Rico (San Juan FIR — US territory but separate FIR)
    fir("TJZS", "Puerto Rico", "PR", [
      [-67.5, 20],
      [-63, 20],
      [-63, 17],
      [-67.5, 17],
      [-67.5, 20],
    ]),

    // ─── Trinidad and Tobago (Piarco FIR) ──────────────────────────
    fir("TTTT", "Trinidad and Tobago", "TT", [
      [-62, 13],
      [-59, 13],
      [-59, 9],
      [-62, 9],
      [-62, 13],
    ]),

    // ─── Cayman Islands (within Miami Oceanic but distinct FIR) ────
    fir("MWCR", "Cayman Islands", "KY", [
      [-82, 20.5],
      [-79, 20.5],
      [-79, 19],
      [-82, 19],
      [-82, 20.5],
    ]),

    // ─── Turks and Caicos ──────────────────────────────────────────
    fir("MBPV", "Turks and Caicos", "TC", [
      [-72.5, 22.5],
      [-70.5, 22.5],
      [-70.5, 21],
      [-72.5, 21],
      [-72.5, 22.5],
    ]),

    // ─── Ecuador ───────────────────────────────────────────────────
    fir("SEGQ", "Ecuador", "EC", [
      [-81, 1.5],
      [-75, 1.5],
      [-75, -5],
      [-81, -5],
      [-81, 1.5],
    ]),

    // ─── Brazil (Amazonic FIR — northern) ──────────────────────────
    fir("SBAZ", "Brazil", "BR", [
      [-60, 5],
      [-50, 5],
      [-44, 0],
      [-44, -10],
      [-60, -10],
      [-60, 1],
      [-60, 5],
    ]),
  ],
};
