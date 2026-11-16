import { serveAttachment } from "@/lib/media/serving";

export async function GET(request: Request, { params }: { params: Promise<{ product: string; lesson: string }> }) {
  const { product, lesson } = await params;
  return serveAttachment(request, product, lesson);
}
