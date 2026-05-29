const { type, name } = $arguments;

const proxies = await produceArtifact({
  name,
  type: /^1$|col/i.test(type) ? 'collection' : 'subscription',
  platform: 'ClashMeta',
  produceType: 'internal',
  produceOpts: { 'delete-underscore-fields': true, 'prettyYaml': true },
});

const yaml = ProxyUtils.yaml;

function yamlDump(obj) {
  return yaml.dump(obj)
    .replace(/\\U([0-9A-Fa-f]{8})/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\u([0-9A-Fa-f]{4})/g,  (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/>-\n\s+/g, '');
}

const config = yaml.load($files[0]);

const VALID_MIHOMO_KEYS = new Set([
  'mode', 'mixed-port', 'port', 'socks-port', 'redir-port', 'tproxy-port',
  'ipv6', 'allow-lan', 'bind-address', 'lan-allowed-ips', 'lan-disallowed-ips',
  'unified-delay', 'tcp-concurrent', 'log-level', 'find-process-mode',
  'geodata-mode', 'geodata-loader', 'geosite-matcher', 'geo-auto-update',
  'geo-update-interval', 'global-ua', 'etag-support', 'disable-keep-alive',
  'keep-alive-idle', 'keep-alive-interval', 'skip-auth-prefixes',
  'external-controller', 'external-ui', 'external-ui-name', 'external-ui-url',
  'secret', 'interface-name', 'routing-mark', 'tun', 'profile',
  'sniffer', 'dns', 'hosts', 'proxies', 'proxy-groups', 'proxy-providers',
  'rules', 'rule-providers', 'sub-rules', 'listeners', 'inbound-tfo',
  'ntp', 'experimental',
]);

for (const key of Object.keys(config)) {
  if (!VALID_MIHOMO_KEYS.has(key)) delete config[key];
}

config.proxies     = Array.isArray(proxies) ? proxies : [];
config['proxy-groups'] = groupProxies(proxies, config['proxy-groups']);

$content = yamlDump(config);

function groupProxies(proxies, groups) {
  const allNames = Array.isArray(proxies)
    ? proxies.map(p => p?.name).filter(n => typeof n === 'string')
    : [];
  const srcGroups = Array.isArray(groups) ? groups : [];

  const groupMap    = new Map();
  const referencedBy = new Map();

  const workingGroups = srcGroups.map(g => {
    const info = {
      ...g,
      __proxySet:  new Set(Array.isArray(g.proxies) ? g.proxies : []),
      __useArr:    Array.isArray(g.use) ? [...g.use] : [],
      __filterFn:  compileMatcher(g.filter),
      __excludeFn: compileMatcher(g['exclude-filter']),
      __includeAll: g['include-all'] === true,
    };
    groupMap.set(g.name, info);

    for (const ref of [...info.__proxySet, ...info.__useArr]) {
      if (!referencedBy.has(ref)) referencedBy.set(ref, new Set());
      referencedBy.get(ref).add(g.name);
    }

    return info;
  });

  for (const g of workingGroups) {
    const hasLogic = g.__filterFn || g.__excludeFn;

    if (g.__includeAll && !hasLogic) {
      for (const n of allNames) g.__proxySet.add(n);
    } else if (hasLogic) {
      for (const n of allNames) {
        if (g.__filterFn  && !g.__filterFn(n))  continue;
        if (g.__excludeFn &&  g.__excludeFn(n))  continue;
        g.__proxySet.add(n);
      }
    }
  }

  const deletedSet = new Set();
  const isEmpty    = g => g.__proxySet.size === 0 && g.__useArr.length === 0;

  const queue = workingGroups.filter(isEmpty).map(g => g.name);

  let head = 0;
  while (head < queue.length) {
    const target = queue[head++];
    if (deletedSet.has(target)) continue;
    deletedSet.add(target);

    const parents = referencedBy.get(target);
    if (!parents) continue;
    for (const parentName of parents) {
      const parent = groupMap.get(parentName);
      if (!parent || deletedSet.has(parentName)) continue;
      parent.__proxySet.delete(target);
      parent.__useArr = parent.__useArr.filter(u => u !== target);
      if (isEmpty(parent)) queue.push(parentName);
    }
  }

  return workingGroups
    .filter(g => !deletedSet.has(g.name))
    .map(g => {
      const out = { ...g, proxies: Array.from(g.__proxySet) };
      if (g.__useArr.length > 0) out.use = g.__useArr; else delete out.use;
      for (const key of Object.keys(out)) {
        if (key.startsWith('__') ||
            key === 'filter' ||
            key === 'exclude-filter' ||
            key === 'include-all') {
          delete out[key];
        }
      }
      return out;
    });
}

function compileMatcher(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;

  const hasIgnoreCase = /\(\?i\)/i.test(raw);
  let cleaned = raw.replace(/\(\?i\)/gi, '');

  let pattern, flags = '';
  const m = cleaned.match(/^\/([\s\S]*)\/([gimsuy]*)$/);
  if (m) {
    pattern = m[1] || '';
    flags   = (m[2] || '').replace(/[gy]/g, '');
  } else {
    pattern = cleaned;
  }

  if (hasIgnoreCase && !flags.includes('i')) flags += 'i';
  if (!flags.includes('u')) flags += 'u';
  flags = [...new Set(flags)].join('');

  try {
    const re = new RegExp(pattern, flags);
    return name => { re.lastIndex = 0; return re.test(name); };
  } catch {
    return null;
  }
}