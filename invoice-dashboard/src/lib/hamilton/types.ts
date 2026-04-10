export interface HamiltonTrip {
  id: string;
  displayCode: string;
  operatorStatus: string;
  createdAt: string;
  updatedAt: string;
  salesAgentId: string;
  autoQuoted: boolean | null;
  lowestPrice: number | null;
  contactId: string;
  contact: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
  } | null;
  contactCompany: {
    id: string;
    title: string;
  } | null;
  legs: {
    departureAirportIcao: string;
    arrivalAirportIcao: string;
    departureDatetime: string;
    pax: number | null;
    minAircraftCategory: {
      displayName: string;
      code: string;
    } | null;
  }[];
  pipelineId: string;
}

export interface HamiltonOperatorTripsResponse {
  operatorTrips: {
    trips: HamiltonTrip[];
    totalRows: number;
    priceArray: number[];
  };
}

export interface HamiltonApiWrapper {
  type: string;
  data: HamiltonOperatorTripsResponse;
  init?: { status: number };
}

export interface DeclineSummaryByAgent {
  salesAgentId: string;
  salesAgentName: string | null;
  count: number;
  totalValue: number;
}

export interface DeclineSyncResult {
  totalDeclines: number;
  tripsUpserted: number;
  agentSummary: DeclineSummaryByAgent[];
  errors: string[];
  sessionExpired: boolean;
}
