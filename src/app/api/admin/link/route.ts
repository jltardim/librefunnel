import { adminLinkRequest } from "@/lib/admin-link";

export async function POST(request: Request) {
  return adminLinkRequest(request);
}
