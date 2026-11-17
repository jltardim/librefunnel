import { enterWithLink } from "@/lib/admin-link";

// A route handler, not a page: the admin layout would ask for the password before this could run.
export async function GET(request: Request) {
  return enterWithLink(request);
}
