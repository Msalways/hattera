export interface PrivateNetworkState {
  available: boolean;
  enabled: boolean;
  state: "disconnected" | "starting" | "sign-in-required" | "approval-required" | "connected" | "error";
  authorizationUrl: string | null;
  origin: string | null;
  message: string | null;
  peers: Array<{ id: string; name: string; online: boolean; addresses: string[] }>;
  peerTransport?: boolean;
}
