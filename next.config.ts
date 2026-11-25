import type { NextConfig } from "next";

const projectDir = process.cwd();

/* Android APK 构建（api-hub-android 仓 CI）：禁用图片优化管线，
   standalone 里的 sharp 原生模块（linux glibc .node）在 Android bionic
   无法加载且运行时用不到——禁用后由新仓 CI 剔除，保持纯 JS 可搬运 */
const isAndroidBuild = process.env.ANDROID_BUILD === "1";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: projectDir,
  turbopack: {
    root: projectDir,
  },
  /* config options here */
  images: isAndroidBuild ? { unoptimized: true, disableStaticImages: true } : undefined,
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
