// Fumadocs bundles this config with esbuild. A computed import leaves package
// resolution to Node, which works in the restricted Windows build environment.
const configPackage = ['fumadocs-mdx', 'config'].join('/');
const schemaPackage = ['fumadocs-core', 'source', 'schema'].join('/');
const { defineDocs } = await import(configPackage) as typeof import('fumadocs-mdx/config');
const { metaSchema, pageSchema } = await import(schemaPackage) as typeof import('fumadocs-core/source/schema');

export const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    files: ['index.mdx', 'setup.mdx', 'capabilities.mdx', 'hosting.mdx'],
    schema: pageSchema,
    postprocess: { includeProcessedMarkdown: true },
  },
  meta: { schema: metaSchema },
});
