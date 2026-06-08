// ================================================
//  app/api/sensor-to-chain/route.js
//  API Route Next.js — dipanggil GitHub Actions
//  setiap 1 jam secara otomatis
// ================================================

import { ethers } from "ethers";
import contractABI from "@/lib/contract_abi.json";

export async function GET(request) {

  // ── Keamanan: hanya boleh dipanggil GitHub Actions ──
  // Tambahkan CRON_SECRET di Vercel Environment Variables
  const secret = request.headers.get("x-cron-secret");
  if (secret !== process.env.CRON_SECRET) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {

    // ── Step 1: Ambil rata-rata dari ThingSpeak ──────
    // ThingSpeak hitung rata-rata otomatis via parameter average=60
    const tsURL = `https://api.thingspeak.com/channels/${process.env.THINGSPEAK_CHANNEL_ID}/feeds.json`;
    const params = new URLSearchParams({
      api_key : process.env.THINGSPEAK_READ_KEY,
      minutes : "60",
      average : "60"   // ThingSpeak agregasi otomatis
    });

    const tsRes  = await fetch(`${tsURL}?${params}`);
    const tsData = await tsRes.json();

    if (!tsData.feeds || tsData.feeds.length === 0) {
      return Response.json({ error: "Tidak ada data ThingSpeak" }, { status: 500 });
    }

    const feed = tsData.feeds[0];
    const suhu  = parseFloat(feed.field1);  // rata-rata suhu °C
    const rh    = parseFloat(feed.field2);  // rata-rata kelembaban udara %
    const tanah = parseFloat(feed.field3);  // rata-rata kelembaban tanah %

    // ── Step 2: Tentukan status kondisi kebun ────────
    const status = tanah < 30 ? "KERING" : tanah < 60 ? "NORMAL" : "BASAH";

    // ── Step 3: Upload JSON metadata ke Pinata ───────
    const metadata = {
      device_id : "NodeMCU_KebunKopi_01",
      periode   : feed.created_at,
      suhu_avg  : suhu,
      rh_avg    : rh,
      tanah_avg : tanah,
      status    : status,
      thingspeak_channel: process.env.THINGSPEAK_CHANNEL_ID
    };

    const pinataRes = await fetch(
      "https://api.pinata.cloud/pinning/pinJSONToIPFS",
      {
        method  : "POST",
        headers : {
          "Content-Type"          : "application/json",
          "pinata_api_key"        : process.env.PINATA_API_KEY,
          "pinata_secret_api_key" : process.env.PINATA_SECRET
        },
        body: JSON.stringify({ pinataContent: metadata })
      }
    );

    const pinataData = await pinataRes.json();
    const cid = `ipfs://${pinataData.IpfsHash}`;

    // ── Step 4: Kirim ke Smart Contract Polygon Amoy ─
    const provider = new ethers.JsonRpcProvider(process.env.POLYGON_AMOY_RPC);
    const wallet   = new ethers.Wallet(process.env.WALLET_PRIVATE_KEY, provider);
    const kontrak  = new ethers.Contract(
      process.env.CONTRACT_ADDRESS,
      contractABI,
      wallet
    );

    // Solidity tidak punya float → suhu x10 (26.4°C → 264)
    const tx = await kontrak.simpanLog(
      cid,
      Math.round(suhu * 10),   // 26.4 → 264
      Math.round(rh),          // 71
      Math.round(tanah),       // 54
      status
    );

    await tx.wait();  // tunggu konfirmasi block

    // ── Response sukses ──────────────────────────────
    return Response.json({
      success  : true,
      txHash   : tx.hash,
      cid      : cid,
      data     : { suhu, rh, tanah, status },
      polygonscan: `https://amoy.polygonscan.com/tx/${tx.hash}`
    });

  } catch (error) {
    console.error("Error:", error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
