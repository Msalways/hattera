export function createWebhookHandler() {
  const invoices = [];
  const seenEventIds = new Set();
  return {
    invoices,
    handle(event) {
      if (seenEventIds.has(event.eventId)) {
        return { accepted: true, duplicate: true };
      }
      seenEventIds.add(event.eventId);
      invoices.push({ eventId: event.eventId, amount: event.amount });
      return { accepted: true };
    },
  };
}
