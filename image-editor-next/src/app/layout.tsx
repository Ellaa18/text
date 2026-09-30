import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TypeStudio — Image Text Editor",
  description: "Live multilingual word-level OCR editing with a Python OCR service.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
