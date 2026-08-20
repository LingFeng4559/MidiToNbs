import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Note Block Forge — MIDI 轉 Note Block Studio NBS",
  description: "在瀏覽器本機批次將 MIDI 轉換成 Open Note Block Studio NBS。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-Hant"><body>{children}</body></html>;
}
