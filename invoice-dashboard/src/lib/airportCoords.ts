/** Lat/lon for airports that appear in Baker Aviation trip data */
export type AirportInfo = {
  code: string;
  name: string;
  lat: number;
  lon: number;
  city: string;
  state: string;
};

const AIRPORTS: Record<string, AirportInfo> = {
  "1B1": { code: "1B1", name: "Columbia County", lat: 42.2913, lon: -73.7103, city: "Hudson", state: "NY" },
  TEB: { code: "TEB", name: "Teterboro", lat: 40.8501, lon: -74.0608, city: "Teterboro", state: "NJ" },
  PSP: { code: "PSP", name: "Palm Springs Intl", lat: 33.8297, lon: -116.5067, city: "Palm Springs", state: "CA" },
  VNY: { code: "VNY", name: "Van Nuys", lat: 34.2098, lon: -118.4899, city: "Van Nuys", state: "CA" },
  PGD: { code: "PGD", name: "Punta Gorda", lat: 26.9202, lon: -81.9905, city: "Punta Gorda", state: "FL" },
  OAK: { code: "OAK", name: "Metropolitan Oakland Intl", lat: 37.7213, lon: -122.2208, city: "Oakland", state: "CA" },
  OPF: { code: "OPF", name: "Opa Locka Executive", lat: 25.9075, lon: -80.2783, city: "Opa Locka", state: "FL" },
  EGE: { code: "EGE", name: "Eagle County Regional", lat: 39.6426, lon: -106.9177, city: "Eagle", state: "CO" },
  MRLB: { code: "MRLB", name: "Daniel Oduber Quiros Intl", lat: 10.5933, lon: -85.5445, city: "Liberia", state: "Costa Rica" },
  IAH: { code: "IAH", name: "G. Bush Intercontinental", lat: 29.9902, lon: -95.3368, city: "Houston", state: "TX" },
  BCT: { code: "BCT", name: "Boca Raton", lat: 26.3785, lon: -80.1077, city: "Boca Raton", state: "FL" },
  FRG: { code: "FRG", name: "Republic", lat: 40.7288, lon: -73.4134, city: "Farmingdale", state: "NY" },
  PBI: { code: "PBI", name: "Palm Beach Intl", lat: 26.6832, lon: -80.0956, city: "West Palm Beach", state: "FL" },
  ALB: { code: "ALB", name: "Albany Intl", lat: 42.7483, lon: -73.8016, city: "Albany", state: "NY" },
  LWS: { code: "LWS", name: "Lewiston Nez Perce County", lat: 46.3745, lon: -117.0153, city: "Lewiston", state: "ID" },
  TRM: { code: "TRM", name: "Jacqueline Cochran Regl", lat: 33.6267, lon: -116.1603, city: "Thermal", state: "CA" },
  MYNN: { code: "MYNN", name: "Lynden Pindling Intl", lat: 25.0390, lon: -77.4662, city: "Nassau", state: "Bahamas" },
  TTN: { code: "TTN", name: "Trenton Mercer", lat: 40.2767, lon: -74.8135, city: "Trenton", state: "NJ" },
  FLL: { code: "FLL", name: "Hollywood Intl", lat: 26.0726, lon: -80.1527, city: "Fort Lauderdale", state: "FL" },
  BUR: { code: "BUR", name: "Bob Hope", lat: 34.2007, lon: -118.3585, city: "Burbank", state: "CA" },
  HPN: { code: "HPN", name: "Westchester County", lat: 41.0670, lon: -73.7076, city: "White Plains", state: "NY" },
  MSN: { code: "MSN", name: "Dane County Regional", lat: 43.1399, lon: -89.3375, city: "Madison", state: "WI" },
  LAS: { code: "LAS", name: "Harry Reid Intl", lat: 36.0840, lon: -115.1537, city: "Las Vegas", state: "NV" },
  MPTO: { code: "MPTO", name: "Tocumen Intl", lat: 9.0714, lon: -79.3835, city: "Panama City", state: "Panama" },
  PGV: { code: "PGV", name: "Pitt Greenville", lat: 35.6352, lon: -77.3853, city: "Greenville", state: "NC" },
  SJC: { code: "SJC", name: "San Jose Intl", lat: 37.3626, lon: -121.9290, city: "San Jose", state: "CA" },
  OMA: { code: "OMA", name: "Eppley Airfield", lat: 41.3032, lon: -95.8940, city: "Omaha", state: "NE" },
  FPR: { code: "FPR", name: "St Lucie County Intl", lat: 27.4951, lon: -80.3679, city: "Fort Pierce", state: "FL" },
  DFW: { code: "DFW", name: "Dallas Ft Worth Intl", lat: 32.8998, lon: -97.0403, city: "Dallas", state: "TX" },
  ADS: { code: "ADS", name: "Addison", lat: 32.9686, lon: -96.8364, city: "Addison", state: "TX" },
  ANB: { code: "ANB", name: "Anniston Rgnl", lat: 33.5882, lon: -85.8581, city: "Anniston", state: "AL" },
  DAL: { code: "DAL", name: "Dallas Love Field", lat: 32.8471, lon: -96.8518, city: "Dallas", state: "TX" },
  BED: { code: "BED", name: "Laurence G Hanscom Fld", lat: 42.4700, lon: -71.2890, city: "Bedford", state: "MA" },
  CMH: { code: "CMH", name: "John Glenn Columbus Intl", lat: 39.9980, lon: -82.8919, city: "Columbus", state: "OH" },
  SNA: { code: "SNA", name: "John Wayne/Orange County", lat: 33.6757, lon: -117.8682, city: "Santa Ana", state: "CA" },
  CLE: { code: "CLE", name: "Cleveland Hopkins Intl", lat: 41.4117, lon: -81.8498, city: "Cleveland", state: "OH" },
  IAD: { code: "IAD", name: "Dulles Intl", lat: 38.9445, lon: -77.4558, city: "Dulles", state: "VA" },
  SRQ: { code: "SRQ", name: "Sarasota/Bradenton Intl", lat: 27.3954, lon: -82.5544, city: "Sarasota", state: "FL" },
  MYEH: { code: "MYEH", name: "North Eleuthera", lat: 25.4749, lon: -76.6835, city: "North Eleuthera", state: "Bahamas" },
  MWCR: { code: "MWCR", name: "Owen Roberts Intl", lat: 19.2928, lon: -81.3577, city: "Grand Cayman", state: "Cayman Islands" },
  STL: { code: "STL", name: "St Louis Lambert Intl", lat: 38.7487, lon: -90.3700, city: "St. Louis", state: "MO" },
  W48MPL: { code: "W48MPL", name: "Teterboro", lat: 40.8501, lon: -74.0608, city: "Teterboro", state: "NJ" },
  TXKF: { code: "TXKF", name: "L.F. Wade Intl", lat: 32.3640, lon: -64.6787, city: "Hamilton", state: "Bermuda" },
  BVO: { code: "BVO", name: "Bartlesville Muni", lat: 36.7625, lon: -95.9827, city: "Bartlesville", state: "OK" },
  TAPA: { code: "TAPA", name: "V.C. Bird International", lat: 17.1368, lon: -61.7927, city: "Antigua", state: "Antigua" },
  CHS: { code: "CHS", name: "Charleston AFB/Intl", lat: 32.8987, lon: -80.0405, city: "Charleston", state: "SC" },
  BZN: { code: "BZN", name: "Bozeman Yellowstone Intl", lat: 45.7775, lon: -111.1528, city: "Bozeman", state: "MT" },
  RIL: { code: "RIL", name: "Garfield County Regional", lat: 39.5263, lon: -107.7263, city: "Rifle", state: "CO" },
  LNK: { code: "LNK", name: "Lincoln Muni", lat: 40.8510, lon: -96.7592, city: "Lincoln", state: "NE" },
  SDL: { code: "SDL", name: "Scottsdale", lat: 33.6229, lon: -111.9111, city: "Scottsdale", state: "AZ" },
  BOS: { code: "BOS", name: "Boston Logan Intl", lat: 42.3656, lon: -71.0096, city: "Boston", state: "MA" },
  SJU: { code: "SJU", name: "Luis Munoz Marin Intl", lat: 18.4394, lon: -66.0018, city: "San Juan", state: "PR" },
  "2IS": { code: "2IS", name: "Airglades", lat: 26.6434, lon: -80.9012, city: "Clewiston", state: "FL" },
  IKG: { code: "IKG", name: "Kleberg County", lat: 27.5189, lon: -97.8628, city: "Kingsville", state: "TX" },
  MDLR: { code: "MDLR", name: "La Romana Intl", lat: 18.4507, lon: -68.9117, city: "La Romana", state: "Dominican Republic" },
  PDX: { code: "PDX", name: "Portland Intl", lat: 45.5898, lon: -122.5951, city: "Portland", state: "OR" },
  PTK: { code: "PTK", name: "Oakland County Intl", lat: 42.6654, lon: -83.4201, city: "Pontiac", state: "MI" },
  PWM: { code: "PWM", name: "Portland Intl Jetport", lat: 43.6462, lon: -70.3093, city: "Portland", state: "ME" },
  ILM: { code: "ILM", name: "Wilmington Intl", lat: 34.2706, lon: -77.9026, city: "Wilmington", state: "NC" },
  MEM: { code: "MEM", name: "Memphis Intl", lat: 35.0424, lon: -89.9767, city: "Memphis", state: "TN" },
  SFO: { code: "SFO", name: "San Francisco Intl", lat: 37.6213, lon: -122.3790, city: "San Francisco", state: "CA" },
  AUS: { code: "AUS", name: "Austin Bergstrom Intl", lat: 30.1975, lon: -97.6664, city: "Austin", state: "TX" },
  SSI: { code: "SSI", name: "Mckinnon St Simons Is.", lat: 31.1519, lon: -81.3913, city: "St. Simons Island", state: "GA" },
  LAL: { code: "LAL", name: "Lakeland Linder Rgnl", lat: 27.9889, lon: -82.0183, city: "Lakeland", state: "FL" },
  SBA: { code: "SBA", name: "Santa Barbara Muni", lat: 34.4262, lon: -119.8401, city: "Santa Barbara", state: "CA" },
  PHL: { code: "PHL", name: "Philadelphia Intl", lat: 39.8744, lon: -75.2424, city: "Philadelphia", state: "PA" },
  TME: { code: "TME", name: "Houston Executive", lat: 29.8073, lon: -95.8991, city: "Houston", state: "TX" },
  MCO: { code: "MCO", name: "Orlando Intl", lat: 28.4312, lon: -81.3081, city: "Orlando", state: "FL" },
  AAO: { code: "AAO", name: "Colonel James Jabara", lat: 37.7475, lon: -97.2211, city: "Wichita", state: "KS" },
  BOI: { code: "BOI", name: "Gowen Field Intl", lat: 43.5644, lon: -116.2228, city: "Boise", state: "ID" },
  LAX: { code: "LAX", name: "Los Angeles Intl", lat: 33.9425, lon: -118.4081, city: "Los Angeles", state: "CA" },
  PIE: { code: "PIE", name: "St. Pete Clearwater Intl", lat: 27.9102, lon: -82.6874, city: "St. Petersburg", state: "FL" },
  SLC: { code: "SLC", name: "Salt Lake City Intl", lat: 40.7884, lon: -111.9778, city: "Salt Lake City", state: "UT" },
  ABE: { code: "ABE", name: "Lehigh Valley Intl", lat: 40.6521, lon: -75.4408, city: "Allentown", state: "PA" },
  NEW: { code: "NEW", name: "Lakefront", lat: 30.0424, lon: -90.0283, city: "New Orleans", state: "LA" },
  BTR: { code: "BTR", name: "Baton Rouge Metropolitan Airport", lat: 30.5332, lon: -91.1496, city: "Baton Rouge", state: "LA" },
  SUA: { code: "SUA", name: "Witham Field", lat: 27.1817, lon: -80.2211, city: "Stuart", state: "FL" },
  JWN: { code: "JWN", name: "John C Tune", lat: 36.1824, lon: -86.8867, city: "Nashville", state: "TN" },
  ORL: { code: "ORL", name: "Orlando Executive", lat: 28.5455, lon: -81.3329, city: "Orlando", state: "FL" },
  MCC: { code: "MCC", name: "Mc Clellan Airfield", lat: 38.6676, lon: -121.4013, city: "Sacramento", state: "CA" },
  PNE: { code: "PNE", name: "Northeast Philadelphia", lat: 40.0819, lon: -75.0107, city: "Philadelphia", state: "PA" },
  TNCA: { code: "TNCA", name: "Reina Beatrix", lat: 12.5014, lon: -70.0152, city: "Oranjestad", state: "Aruba" },
  APA: { code: "APA", name: "Centennial", lat: 39.5701, lon: -104.8492, city: "Englewood", state: "CO" },
  YKM: { code: "YKM", name: "Yakima Air Terminal", lat: 46.5682, lon: -120.5444, city: "Yakima", state: "WA" },
  ORF: { code: "ORF", name: "Norfolk Intl", lat: 36.8976, lon: -76.0123, city: "Norfolk", state: "VA" },
  ASE: { code: "ASE", name: "Aspen Pitkin Co/Sardy Fld", lat: 39.2232, lon: -106.8687, city: "Aspen", state: "CO" },
  TIX: { code: "TIX", name: "Space Coast Regional", lat: 28.5148, lon: -80.7992, city: "Titusville", state: "FL" },
  GTU: { code: "GTU", name: "Georgetown Muni", lat: 30.6788, lon: -97.6794, city: "Georgetown", state: "TX" },
  APF: { code: "APF", name: "Naples", lat: 26.1526, lon: -81.7753, city: "Naples", state: "FL" },
  MMMY: { code: "MMMY", name: "Gen. M. Escobedo Intl", lat: 25.7746, lon: -100.1068, city: "Monterrey", state: "Mexico" },
  SGF: { code: "SGF", name: "Springfield Branson Rgnl", lat: 37.2457, lon: -93.3886, city: "Springfield", state: "MO" },
  INT: { code: "INT", name: "Smith Reynolds", lat: 36.1337, lon: -80.2220, city: "Winston-Salem", state: "NC" },
  FMY: { code: "FMY", name: "Page Field", lat: 26.5866, lon: -81.8633, city: "Fort Myers", state: "FL" },
  WYQ91O: { code: "WYQ91O", name: "Eagle County Regional", lat: 39.6426, lon: -106.9177, city: "Eagle", state: "CO" },
  LYH: { code: "LYH", name: "Preston Glenn Field", lat: 37.3267, lon: -79.2004, city: "Lynchburg", state: "VA" },
  HOU: { code: "HOU", name: "William P Hobby", lat: 29.6454, lon: -95.2789, city: "Houston", state: "TX" },
  OXC: { code: "OXC", name: "Waterbury Oxford", lat: 41.4786, lon: -73.1352, city: "Oxford", state: "CT" },
  RDU: { code: "RDU", name: "Raleigh Durham Intl", lat: 35.8776, lon: -78.7875, city: "Raleigh", state: "NC" },
  TKI: { code: "TKI", name: "Mckinney National Airport", lat: 33.1779, lon: -96.5909, city: "McKinney", state: "TX" },
  MRY: { code: "MRY", name: "Monterey Rgnl", lat: 36.5870, lon: -121.8429, city: "Monterey", state: "CA" },
  BUY: { code: "BUY", name: "Burlington Alamance Rgnl", lat: 36.0482, lon: -79.4749, city: "Burlington", state: "NC" },
  VRB: { code: "VRB", name: "Vero Beach Muni", lat: 27.6556, lon: -80.4179, city: "Vero Beach", state: "FL" },
  // ── Additional common US airports ──
  ABQ: { code: "ABQ", name: "Albuquerque Intl Sunport", lat: 35.0402, lon: -106.6092, city: "Albuquerque", state: "NM" },
  ACK: { code: "ACK", name: "Nantucket Memorial", lat: 41.2531, lon: -70.0604, city: "Nantucket", state: "MA" },
  AGS: { code: "AGS", name: "Augusta Regional", lat: 33.3699, lon: -81.9645, city: "Augusta", state: "GA" },
  ATL: { code: "ATL", name: "Hartsfield-Jackson Atlanta Intl", lat: 33.6407, lon: -84.4277, city: "Atlanta", state: "GA" },
  AVL: { code: "AVL", name: "Asheville Regional", lat: 35.4362, lon: -82.5418, city: "Asheville", state: "NC" },
  AVQ: { code: "AVQ", name: "Marana Regional", lat: 32.4097, lon: -111.2184, city: "Marana", state: "AZ" },
  BDL: { code: "BDL", name: "Bradley Intl", lat: 41.9389, lon: -72.6832, city: "Windsor Locks", state: "CT" },
  BFI: { code: "BFI", name: "Boeing Field", lat: 47.53, lon: -122.3019, city: "Seattle", state: "WA" },
  BGR: { code: "BGR", name: "Bangor Intl", lat: 44.8074, lon: -68.8281, city: "Bangor", state: "ME" },
  BHM: { code: "BHM", name: "Birmingham-Shuttlesworth Intl", lat: 33.5629, lon: -86.7535, city: "Birmingham", state: "AL" },
  BKV: { code: "BKV", name: "Brooksville-Tampa Bay Regional", lat: 28.4736, lon: -82.4544, city: "Brooksville", state: "FL" },
  BNA: { code: "BNA", name: "Nashville Intl", lat: 36.1263, lon: -86.6774, city: "Nashville", state: "TN" },
  BUF: { code: "BUF", name: "Buffalo Niagara Intl", lat: 42.9405, lon: -78.7322, city: "Buffalo", state: "NY" },
  BVS: { code: "BVS", name: "Skagit Regional", lat: 48.4706, lon: -122.4208, city: "Burlington", state: "WA" },
  BWI: { code: "BWI", name: "Baltimore-Washington Intl", lat: 39.1754, lon: -76.6683, city: "Baltimore", state: "MD" },
  CDW: { code: "CDW", name: "Essex County", lat: 40.8752, lon: -74.2814, city: "Caldwell", state: "NJ" },
  CGF: { code: "CGF", name: "Cuyahoga County", lat: 41.5651, lon: -81.4864, city: "Cleveland", state: "OH" },
  CLT: { code: "CLT", name: "Charlotte Douglas Intl", lat: 35.214, lon: -80.9431, city: "Charlotte", state: "NC" },
  CMA: { code: "CMA", name: "Camarillo", lat: 34.2137, lon: -119.0943, city: "Camarillo", state: "CA" },
  CRQ: { code: "CRQ", name: "McClellan-Palomar", lat: 33.1283, lon: -117.2803, city: "Carlsbad", state: "CA" },
  CRW: { code: "CRW", name: "Yeager", lat: 38.3731, lon: -81.5933, city: "Charleston", state: "WV" },
  CVG: { code: "CVG", name: "Cincinnati Northern Kentucky Intl", lat: 39.0488, lon: -84.6678, city: "Cincinnati", state: "OH" },
  DAB: { code: "DAB", name: "Daytona Beach Intl", lat: 29.1799, lon: -81.0581, city: "Daytona Beach", state: "FL" },
  DCA: { code: "DCA", name: "Ronald Reagan Washington National", lat: 38.8512, lon: -77.0402, city: "Arlington", state: "VA" },
  DED: { code: "DED", name: "DeLand Municipal", lat: 29.0697, lon: -81.2836, city: "DeLand", state: "FL" },
  DEN: { code: "DEN", name: "Denver Intl", lat: 39.8561, lon: -104.6737, city: "Denver", state: "CO" },
  DSM: { code: "DSM", name: "Des Moines Intl", lat: 41.534, lon: -93.6631, city: "Des Moines", state: "IA" },
  DTS: { code: "DTS", name: "Destin Executive", lat: 30.4001, lon: -86.4715, city: "Destin", state: "FL" },
  DTW: { code: "DTW", name: "Detroit Metropolitan Wayne County", lat: 42.2124, lon: -83.3534, city: "Detroit", state: "MI" },
  DVT: { code: "DVT", name: "Deer Valley", lat: 33.6883, lon: -112.0833, city: "Phoenix", state: "AZ" },
  ECP: { code: "ECP", name: "Northwest Florida Beaches Intl", lat: 30.3571, lon: -85.7955, city: "Panama City", state: "FL" },
  EDC: { code: "EDC", name: "Austin Executive", lat: 30.3974, lon: -97.5664, city: "Austin", state: "TX" },
  ELP: { code: "ELP", name: "El Paso Intl", lat: 31.8067, lon: -106.3778, city: "El Paso", state: "TX" },
  EWR: { code: "EWR", name: "Newark Liberty Intl", lat: 40.6895, lon: -74.1745, city: "Newark", state: "NJ" },
  FCI: { code: "FCI", name: "Chesterfield County", lat: 37.4065, lon: -77.5253, city: "Richmond", state: "VA" },
  FFZ: { code: "FFZ", name: "Falcon Field", lat: 33.4608, lon: -111.7285, city: "Mesa", state: "AZ" },
  FTW: { code: "FTW", name: "Meacham Intl", lat: 32.8198, lon: -97.3623, city: "Fort Worth", state: "TX" },
  FXE: { code: "FXE", name: "Fort Lauderdale Executive", lat: 26.1973, lon: -80.1707, city: "Fort Lauderdale", state: "FL" },
  GDJ: { code: "GDJ", name: "Granbury Regional", lat: 32.4444, lon: -97.8169, city: "Granbury", state: "TX" },
  GFK: { code: "GFK", name: "Grand Forks Intl", lat: 47.9493, lon: -97.1762, city: "Grand Forks", state: "ND" },
  GGG: { code: "GGG", name: "East Texas Regional", lat: 32.384, lon: -94.7115, city: "Longview", state: "TX" },
  GNV: { code: "GNV", name: "Gainesville Regional", lat: 29.69, lon: -82.2718, city: "Gainesville", state: "FL" },
  GPI: { code: "GPI", name: "Glacier Park Intl", lat: 48.3105, lon: -114.2560, city: "Kalispell", state: "MT" },
  GPT: { code: "GPT", name: "Gulfport-Biloxi Intl", lat: 30.4073, lon: -89.0701, city: "Gulfport", state: "MS" },
  GRR: { code: "GRR", name: "Gerald R Ford Intl", lat: 42.8808, lon: -85.5228, city: "Grand Rapids", state: "MI" },
  GSO: { code: "GSO", name: "Piedmont Triad Intl", lat: 36.0978, lon: -79.9373, city: "Greensboro", state: "NC" },
  GSP: { code: "GSP", name: "Greenville-Spartanburg Intl", lat: 34.8957, lon: -82.2189, city: "Greer", state: "SC" },
  HCR: { code: "HCR", name: "Heber Springs Municipal", lat: 35.5117, lon: -91.5733, city: "Heber Springs", state: "AR" },
  HEF: { code: "HEF", name: "Manassas Regional", lat: 38.7214, lon: -77.5155, city: "Manassas", state: "VA" },
  HIO: { code: "HIO", name: "Portland Hillsboro", lat: 45.5404, lon: -122.9498, city: "Hillsboro", state: "OR" },
  HNL: { code: "HNL", name: "Daniel K Inouye Intl", lat: 21.3187, lon: -157.9225, city: "Honolulu", state: "HI" },
  HSV: { code: "HSV", name: "Huntsville Intl", lat: 34.6372, lon: -86.7751, city: "Huntsville", state: "AL" },
  HXD: { code: "HXD", name: "Hilton Head", lat: 32.2244, lon: -80.6975, city: "Hilton Head Island", state: "SC" },
  ICT: { code: "ICT", name: "Wichita Eisenhower National", lat: 37.6499, lon: -97.4331, city: "Wichita", state: "KS" },
  IND: { code: "IND", name: "Indianapolis Intl", lat: 39.7173, lon: -86.2944, city: "Indianapolis", state: "IN" },
  ISP: { code: "ISP", name: "Long Island MacArthur", lat: 40.7952, lon: -73.1002, city: "Ronkonkoma", state: "NY" },
  IWA: { code: "IWA", name: "Phoenix-Mesa Gateway", lat: 33.3078, lon: -111.6556, city: "Mesa", state: "AZ" },
  IXD: { code: "IXD", name: "New Century AirCenter", lat: 38.8309, lon: -94.8903, city: "Olathe", state: "KS" },
  JAC: { code: "JAC", name: "Jackson Hole", lat: 43.6073, lon: -110.7377, city: "Jackson", state: "WY" },
  JAN: { code: "JAN", name: "Jackson-Medgar Wiley Evers Intl", lat: 32.3112, lon: -90.0759, city: "Jackson", state: "MS" },
  JAX: { code: "JAX", name: "Jacksonville Intl", lat: 30.4941, lon: -81.6879, city: "Jacksonville", state: "FL" },
  JFK: { code: "JFK", name: "John F Kennedy Intl", lat: 40.6413, lon: -73.7781, city: "New York", state: "NY" },
  JQF: { code: "JQF", name: "Concord-Padgett Regional", lat: 35.3878, lon: -80.7089, city: "Concord", state: "NC" },
  JYO: { code: "JYO", name: "Leesburg Executive", lat: 39.0780, lon: -77.5575, city: "Leesburg", state: "VA" },
  LEX: { code: "LEX", name: "Blue Grass", lat: 38.0365, lon: -84.6059, city: "Lexington", state: "KY" },
  LFT: { code: "LFT", name: "Lafayette Regional", lat: 30.2053, lon: -91.9876, city: "Lafayette", state: "LA" },
  LGA: { code: "LGA", name: "LaGuardia", lat: 40.7769, lon: -73.874, city: "New York", state: "NY" },
  LIT: { code: "LIT", name: "Clinton National", lat: 34.7294, lon: -92.2243, city: "Little Rock", state: "AR" },
  LUK: { code: "LUK", name: "Cincinnati Lunken", lat: 39.1033, lon: -84.4186, city: "Cincinnati", state: "OH" },
  MCI: { code: "MCI", name: "Kansas City Intl", lat: 39.2976, lon: -94.7139, city: "Kansas City", state: "MO" },
  MDW: { code: "MDW", name: "Chicago Midway Intl", lat: 41.7868, lon: -87.7522, city: "Chicago", state: "IL" },
  MHT: { code: "MHT", name: "Manchester-Boston Regional", lat: 42.9326, lon: -71.4357, city: "Manchester", state: "NH" },
  MIA: { code: "MIA", name: "Miami Intl", lat: 25.7959, lon: -80.287, city: "Miami", state: "FL" },
  MKE: { code: "MKE", name: "General Mitchell Intl", lat: 42.9472, lon: -87.8966, city: "Milwaukee", state: "WI" },
  MKY: { code: "MKY", name: "Marco Island Executive", lat: 25.9950, lon: -81.6725, city: "Marco Island", state: "FL" },
  MLB: { code: "MLB", name: "Melbourne Orlando Intl", lat: 28.1025, lon: -80.6453, city: "Melbourne", state: "FL" },
  MMU: { code: "MMU", name: "Morristown Muni", lat: 40.7994, lon: -74.4149, city: "Morristown", state: "NJ" },
  MOB: { code: "MOB", name: "Mobile Regional", lat: 30.6914, lon: -88.2428, city: "Mobile", state: "AL" },
  MSP: { code: "MSP", name: "Minneapolis-St Paul Intl", lat: 44.8848, lon: -93.2223, city: "Minneapolis", state: "MN" },
  MSY: { code: "MSY", name: "Louis Armstrong New Orleans Intl", lat: 29.9934, lon: -90.258, city: "New Orleans", state: "LA" },
  MTJ: { code: "MTJ", name: "Montrose Regional", lat: 38.5098, lon: -107.8943, city: "Montrose", state: "CO" },
  MVY: { code: "MVY", name: "Martha's Vineyard", lat: 41.3934, lon: -70.6143, city: "Vineyard Haven", state: "MA" },
  MYR: { code: "MYR", name: "Myrtle Beach Intl", lat: 33.6797, lon: -78.9283, city: "Myrtle Beach", state: "SC" },
  OFP: { code: "OFP", name: "Hanover County Municipal", lat: 37.7092, lon: -77.4364, city: "Ashland", state: "VA" },
  OGG: { code: "OGG", name: "Kahului", lat: 20.8986, lon: -156.4305, city: "Kahului", state: "HI" },
  OKC: { code: "OKC", name: "Will Rogers World", lat: 35.3931, lon: -97.6007, city: "Oklahoma City", state: "OK" },
  OKV: { code: "OKV", name: "Winchester Regional", lat: 39.1435, lon: -78.1444, city: "Winchester", state: "VA" },
  ONT: { code: "ONT", name: "Ontario Intl", lat: 34.056, lon: -117.6012, city: "Ontario", state: "CA" },
  ORD: { code: "ORD", name: "Chicago O'Hare Intl", lat: 41.9742, lon: -87.9073, city: "Chicago", state: "IL" },
  PAE: { code: "PAE", name: "Paine Field", lat: 47.9063, lon: -122.2815, city: "Everett", state: "WA" },
  PDK: { code: "PDK", name: "DeKalb Peachtree", lat: 33.8756, lon: -84.302, city: "Atlanta", state: "GA" },
  PHX: { code: "PHX", name: "Phoenix Sky Harbor Intl", lat: 33.4373, lon: -112.0078, city: "Phoenix", state: "AZ" },
  PIT: { code: "PIT", name: "Pittsburgh Intl", lat: 40.4915, lon: -80.2329, city: "Pittsburgh", state: "PA" },
  PNS: { code: "PNS", name: "Pensacola Intl", lat: 30.4734, lon: -87.1866, city: "Pensacola", state: "FL" },
  PVD: { code: "PVD", name: "T.F. Green Intl", lat: 41.7326, lon: -71.4204, city: "Providence", state: "RI" },
  PWK: { code: "PWK", name: "Chicago Executive", lat: 42.1142, lon: -87.9015, city: "Wheeling", state: "IL" },
  RIC: { code: "RIC", name: "Richmond Intl", lat: 37.5052, lon: -77.3197, city: "Richmond", state: "VA" },
  RNO: { code: "RNO", name: "Reno Tahoe Intl", lat: 39.4991, lon: -119.7681, city: "Reno", state: "NV" },
  ROC: { code: "ROC", name: "Rochester Intl", lat: 43.1189, lon: -77.6724, city: "Rochester", state: "NY" },
  RSW: { code: "RSW", name: "Southwest Florida Intl", lat: 26.5362, lon: -81.7552, city: "Fort Myers", state: "FL" },
  RYY: { code: "RYY", name: "McCollum Field", lat: 34.0131, lon: -84.5972, city: "Kennesaw", state: "GA" },
  SAF: { code: "SAF", name: "Santa Fe Muni", lat: 35.6171, lon: -106.0892, city: "Santa Fe", state: "NM" },
  SAN: { code: "SAN", name: "San Diego Intl", lat: 32.7336, lon: -117.1897, city: "San Diego", state: "CA" },
  SAT: { code: "SAT", name: "San Antonio Intl", lat: 29.5337, lon: -98.4698, city: "San Antonio", state: "TX" },
  SAV: { code: "SAV", name: "Savannah Hilton Head Intl", lat: 32.1276, lon: -81.2021, city: "Savannah", state: "GA" },
  SBN: { code: "SBN", name: "South Bend Intl", lat: 41.7087, lon: -86.3173, city: "South Bend", state: "IN" },
  SDF: { code: "SDF", name: "Louisville Muhammad Ali Intl", lat: 38.1744, lon: -85.736, city: "Louisville", state: "KY" },
  SDM: { code: "SDM", name: "Brown Field Muni", lat: 32.5723, lon: -116.9803, city: "San Diego", state: "CA" },
  SEA: { code: "SEA", name: "Seattle-Tacoma Intl", lat: 47.4502, lon: -122.3088, city: "Seattle", state: "WA" },
  SGJ: { code: "SGJ", name: "Northeast Florida Regional", lat: 29.9592, lon: -81.3397, city: "St. Augustine", state: "FL" },
  SGR: { code: "SGR", name: "Sugar Land Regional", lat: 29.6222, lon: -95.6565, city: "Sugar Land", state: "TX" },
  SHV: { code: "SHV", name: "Shreveport Regional", lat: 32.4466, lon: -93.8256, city: "Shreveport", state: "LA" },
  SIG: { code: "SIG", name: "Norfolk Naval Station", lat: 36.8903, lon: -76.2892, city: "Norfolk", state: "VA" },
  SMF: { code: "SMF", name: "Sacramento Intl", lat: 38.6954, lon: -121.5908, city: "Sacramento", state: "CA" },
  SMO: { code: "SMO", name: "Santa Monica Muni", lat: 34.0158, lon: -118.4513, city: "Santa Monica", state: "CA" },
  SUN: { code: "SUN", name: "Friedman Memorial", lat: 43.5044, lon: -114.296, city: "Hailey", state: "ID" },
  SWF: { code: "SWF", name: "New York Stewart Intl", lat: 41.5041, lon: -74.1048, city: "New Windsor", state: "NY" },
  SYR: { code: "SYR", name: "Syracuse Hancock Intl", lat: 43.1112, lon: -76.1063, city: "Syracuse", state: "NY" },
  TMB: { code: "TMB", name: "Kendall-Tamiami Executive", lat: 25.6479, lon: -80.4328, city: "Miami", state: "FL" },
  TPA: { code: "TPA", name: "Tampa Intl", lat: 27.9756, lon: -82.5333, city: "Tampa", state: "FL" },
  TTD: { code: "TTD", name: "Portland Troutdale", lat: 45.5494, lon: -122.4013, city: "Troutdale", state: "OR" },
  TUL: { code: "TUL", name: "Tulsa Intl", lat: 36.1984, lon: -95.8881, city: "Tulsa", state: "OK" },
  TUS: { code: "TUS", name: "Tucson Intl", lat: 32.1161, lon: -110.941, city: "Tucson", state: "AZ" },
  TYS: { code: "TYS", name: "McGhee Tyson", lat: 35.8109, lon: -83.994, city: "Knoxville", state: "TN" },
  VDF: { code: "VDF", name: "Tampa Executive", lat: 28.0142, lon: -82.3453, city: "Tampa", state: "FL" },
  VPS: { code: "VPS", name: "Destin-Fort Walton Beach", lat: 30.4832, lon: -86.5254, city: "Valparaiso", state: "FL" },
};

// Worldwide airport coordinates fallback (ICAO + IATA keyed)
// Each entry: [lat, lon, name]
import allAirports from "./airports.json";
const worldwide = allAirports as unknown as Record<string, [number, number, string]>;

export function getAirportInfo(code: string): AirportInfo | null {
  // Prefer the curated Baker list (has city/state)
  const curated = AIRPORTS[code];
  if (curated) return curated;

  // Try K-stripped version against curated (KSBN → SBN, KTEB → TEB)
  const stripped = code.replace(/^K/, "");
  if (stripped !== code) {
    const curatedStripped = AIRPORTS[stripped];
    if (curatedStripped) return curatedStripped;
  }

  // Fallback to worldwide dataset (try original, then stripped)
  const entry = worldwide[code] ?? (stripped !== code ? worldwide[stripped] : undefined);
  if (entry) {
    return { code: stripped !== code ? stripped : code, name: entry[2], lat: entry[0], lon: entry[1], city: "", state: "" };
  }
  return null;
}

export function getAllAirports(): AirportInfo[] {
  return Object.values(AIRPORTS);
}

/** Haversine distance in nautical miles */
export function distNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3440.065; // earth radius in nm
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Find the nearest airport to a lat/lon within maxNm nautical miles */
export function findNearestAirport(
  lat: number,
  lon: number,
  maxNm: number = 15,
): AirportInfo | null {
  let best: AirportInfo | null = null;
  let bestDist = Infinity;

  // Check curated airports first
  for (const ap of Object.values(AIRPORTS)) {
    const d = distNm(lat, lon, ap.lat, ap.lon);
    if (d < bestDist) { bestDist = d; best = ap; }
  }

  // Check worldwide dataset
  for (const [code, entry] of Object.entries(worldwide)) {
    const d = distNm(lat, lon, entry[0], entry[1]);
    if (d < bestDist) {
      bestDist = d;
      best = { code, name: entry[2], lat: entry[0], lon: entry[1], city: "", state: "" };
    }
  }

  return bestDist <= maxNm ? best : null;
}

export default AIRPORTS;
