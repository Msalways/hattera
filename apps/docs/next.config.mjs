import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX({ macro: false });

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
};

export default withMDX(config);
