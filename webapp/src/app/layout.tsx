import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "人机协同教研系统",
  description: "人工智能赋能教师教学反思",
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
