export function withLegacyEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function defaultDataDirectory(home: string, exists?: (path: string) => boolean): string;
export function applyEnvironmentAliases(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
declare const compatibility: { withLegacyEnvironment: typeof withLegacyEnvironment; defaultDataDirectory: typeof defaultDataDirectory };
export default compatibility;
