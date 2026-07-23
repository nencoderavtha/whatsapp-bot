/** Download a WhatsApp Cloud API media object (two-step Graph API fetch). */
export async function fetchMetaMedia(
  mediaId: string,
  token: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const metaResp = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!metaResp.ok) throw new Error(`Failed to fetch media metadata (${metaResp.status})`);
  const meta = (await metaResp.json()) as { url: string; mime_type: string };

  const fileResp = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
  if (!fileResp.ok) throw new Error(`Failed to download media file (${fileResp.status})`);
  const arrayBuffer = await fileResp.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), mimeType: meta.mime_type };
}
