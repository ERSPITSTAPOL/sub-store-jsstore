const { type, name } = $arguments;

let config = JSON.parse($files[0]);

const outbounds = await produceArtifact({
  name,
  type: /^1$|col/i.test(type) ? 'collection' : 'subscription',
  platform: 'sing-box',
  produceType: 'internal',
});

function DuplicateNodeName(nodes) {
  const existingTags = new Set();
  const nextIndex = new Map();

  for (const nodeList of Object.values(nodes)) {
    if (!Array.isArray(nodeList)) continue;
    for (const node of nodeList) {
      const rawTag = node && node.tag;
      let currentTag;
      if (typeof rawTag === 'string') {
        const stripped = rawTag.trim();
        currentTag = stripped ? stripped : 'Unknown';
      } else {
        currentTag = 'Unknown';
      }

      node.tag = currentTag;

      if (!existingTags.has(currentTag)) {
        existingTags.add(currentTag);
        nextIndex.set(currentTag, 2);
        continue;
      }

      let idx = nextIndex.get(currentTag) || 2;
      let newTag = `${currentTag} [${idx}]`;
      while (existingTags.has(newTag)) {
        idx += 1;
        newTag = `${currentTag} [${idx}]`;
      }
      node.tag = newTag;
      existingTags.add(newTag);
      nextIndex.set(currentTag, idx + 1);
    }
  }
}

DuplicateNodeName({ outbounds });
const outboundTags = Array.isArray(outbounds) ? outbounds.map(p => p.tag) : [];

function resolveOutboundGroups(outbounds, outboundTags) {
    const allTags = Array.isArray(outboundTags)
        ? outboundTags.filter(t => typeof t === 'string')
        : [];

    const compileMatcher = (raw) => {
        if (typeof raw !== 'string' || !raw) return null;

        let pattern = raw;
        let flags = '';

        const m = raw.match(/^\/([\s\S]*)\/([gimsuy]*)$/);
        if (m) {
            pattern = m[1] || '';
            flags = m[2] || '';
        }

        const inlineFlags = new Set();
        pattern = pattern.replace(/\(\?([imsu])\)/gi, (_, f) => {
            inlineFlags.add(f.toLowerCase());
            return '';
        });

        flags = (flags || '').replace(/[gy]/g, '');
        for (const f of inlineFlags) flags += f;

        if (!flags.includes('u')) flags += 'u';
        // if (flags === '') flags += 'i';

        flags = [...new Set(flags)].join('');

        try {
            const re = new RegExp(pattern || '^$', flags);
            return (s) => {
                re.lastIndex = 0;
                return re.test(s);
            };
        } catch {
            return null;
        }
    };

    const groupMap = new Map();
    const referencedBy = new Map();

    const templateList = Array.isArray(outbounds) ? outbounds : (outbounds?.outbounds || []);

    for (const o of templateList) {
        if (!o?.tag) continue;
        groupMap.set(o.tag, {
            ...o,
            __outboundSet: new Set(Array.isArray(o.outbounds) ? o.outbounds : []),
            __filters: Array.isArray(o.filter) ? o.filter : [],
        });
    }

    for (const g of groupMap.values()) {
        for (const f of g.__filters) {
            if (!f?.action) continue;

            if (f.action === 'all') {
                for (const tag of allTags) g.__outboundSet.add(tag);
                continue;
            }

            const kws = Array.isArray(f.keywords) ? f.keywords : [f.keywords];
            const matchers = kws.map(kw => compileMatcher(kw)).filter(m => m !== null);
            if (!matchers.length && f.action !== 'exclude') continue;

            if (f.action === 'include') {
                for (const name of allTags) {
                    if (matchers.some(m => m(name))) g.__outboundSet.add(name);
                }
            } else if (f.action === 'exclude') {
                if (g.__outboundSet.size === 0) {
                    for (const tag of allTags) g.__outboundSet.add(tag);
                }
                for (const name of g.__outboundSet) {
                    if (matchers.some(m => m(name))) g.__outboundSet.delete(name);
                }
            }
        }
    }

    for (const g of groupMap.values()) {
        for (const ref of g.__outboundSet) {
            if (groupMap.has(ref)) {
                if (!referencedBy.has(ref)) referencedBy.set(ref, new Set());
                referencedBy.get(ref).add(g.tag);
            }
        }
    }

    const removed = new Set();
    const queue = [];

    for (const g of groupMap.values()) {
        if (g.__outboundSet.size === 0) queue.push(g.tag);
    }

    let head = 0;
    while (head < queue.length) {
        const deadTag = queue[head++];
        if (removed.has(deadTag)) continue;
        removed.add(deadTag);

        const parents = referencedBy.get(deadTag);
        if (parents) {
            for (const parentTag of parents) {
                const pg = groupMap.get(parentTag);
                if (!pg || removed.has(parentTag)) continue;

                pg.__outboundSet.delete(deadTag);
                if (pg.default === deadTag) delete pg.default;
                if (pg.__outboundSet.size === 0) queue.push(parentTag);
            }
        }
    }

    const result = [];
    for (const [tag, g] of groupMap) {
        if (removed.has(tag)) continue;
        const out = { ...g, outbounds: Array.from(g.__outboundSet) };
        delete out.__outboundSet;
        delete out.__filters;
        delete out.filter;
        result.push(out);
    }

    return result;
}

const resolvedGroups = resolveOutboundGroups(config.outbounds, outboundTags);

config.outbounds = [
  ...(Array.isArray(resolvedGroups) ? resolvedGroups : []),
  ...(Array.isArray(outbounds) ? outbounds : []),
];

$content = JSON.stringify(config, null, 2);