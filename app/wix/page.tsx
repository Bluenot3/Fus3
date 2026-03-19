import type { Metadata } from "next";
import { WixCommandCenter } from "@/components/wix-command-center";

export const metadata: Metadata = {
  title: "Wix Command Center",
  description: "Mobile-friendly Wix site operations overview for ZEN Command Center"
};

export default function WixPage() {
  return <WixCommandCenter />;
}
