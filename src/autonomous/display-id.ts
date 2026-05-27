export function displayId(item: { id: string } & Record<string, unknown>): string {
  return (item.displayId as string | undefined) ?? item.id;
}
