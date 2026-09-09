/** Environment values are private; only these explicit example names are inputs. */
export function isPrivateEnvironmentFile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === '.env' || (lower.startsWith('.env.')
    && !['.env.example', '.env.sample', '.env.template'].includes(lower));
}

export function isPrivateConfigurationFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (isPrivateEnvironmentFile(name)) return true;
  if (['.dev.vars', '.envrc', '.npmrc', '.pypirc', '.netrc', 'credentials', 'credentials.json', 'service-account.json',
    'id_rsa', 'id_ed25519'].includes(lower)) return true;
  return false;
}

/** The same private file names are omitted from source snapshots and masked by bwrap. */
export function isPrivateWorkspaceFile(name: string): boolean {
  const lower = name.toLowerCase();
  return isPrivateConfigurationFile(name) || /\.(?:pem|key|p12|pfx)$/.test(lower)
    || /(?:credential|service-account|private-key).+\.json$/.test(lower);
}
