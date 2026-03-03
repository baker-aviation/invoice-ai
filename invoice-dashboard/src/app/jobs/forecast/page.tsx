import { Topbar } from "@/components/Topbar";
import JobsNav from "../JobsNav";
import ForecastBoard from "./ForecastBoard";

export default function ForecastPage() {
  return (
    <>
      <Topbar title="Jobs" />
      <JobsNav />
      <ForecastBoard />
    </>
  );
}
