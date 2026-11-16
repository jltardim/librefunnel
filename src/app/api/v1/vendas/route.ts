import { salesReport } from "@/lib/sales";

export async function GET(request: Request) {
  return salesReport(request);
}
