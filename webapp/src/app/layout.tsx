import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI 教学反思系统",
  description: "AI 辅助教师教学反思与成长平台",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen bg-gray-50 text-slate-900">
        {children}
      </body>
    </html>
  );
}
