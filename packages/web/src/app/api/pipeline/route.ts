import { NextResponse } from "next/server";
import { getServices, getPipelineFindings } from "@/lib/services";

export async function GET() {
  try {
    const findings = await getPipelineFindings();

    // Serialize dates for JSON transport
    const serialized = findings.map((f) => ({
      ...f,
      detectedAt: f.detectedAt.toISOString(),
      lastAttemptAt: f.lastAttemptAt?.toISOString() ?? null,
    }));

    return NextResponse.json({ findings: serialized });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to fetch pipeline findings" },
      { status: 500 },
    );
  }
}

/** Trigger an immediate scan cycle */
export async function POST() {
  try {
    const { pipelineScanner } = await getServices();
    const findings = await pipelineScanner.scanOnce();

    const serialized = findings.map((f) => ({
      ...f,
      detectedAt: f.detectedAt.toISOString(),
      lastAttemptAt: f.lastAttemptAt?.toISOString() ?? null,
    }));

    return NextResponse.json({ findings: serialized, scanned: true });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to run pipeline scan" },
      { status: 500 },
    );
  }
}
