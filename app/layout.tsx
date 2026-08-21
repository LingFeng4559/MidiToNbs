import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://lingfeng4559.github.io/MidiToNbs/"),
  title: "MidiToNbs — MIDI 轉 Note Block Studio NBS",
  description: "在瀏覽器本機批次將 MIDI 轉換成 Open Note Block Studio NBS。",
  openGraph: {
    title: "MidiToNbs — MIDI 轉 NBS",
    description: "瀏覽器本機批次轉換 MIDI，下載真正的 Open Note Block Studio NBS v5。",
    url: "/",
    siteName: "MidiToNbs",
    images: [{ url: "/og.png", width: 1731, height: 909 }],
    locale: "zh_TW",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "MidiToNbs — MIDI 轉 NBS",
    description: "瀏覽器本機批次轉換 MIDI，下載真正的 Open Note Block Studio NBS v5。",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-Hant"><body>{children}</body></html>;
}
