export function createWebhookHandler() {
  const invoices = [];
  return {
    invoices,
    handle(event) {
      invoices.push({ eventId: event.eventId, amount: event.amount });
      return { accepted: true };
    },
  };
}
