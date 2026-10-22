import { useState, type ReactNode } from "react";

export interface StreamInfo {
  streamId?: string | null;
  tier?: number | null;
  calibrated?: boolean;
  fps?: number | null;
  validFrames?: number;
  totalFrames?: number;
  goodputBytesPerSecond?: number | null;
  lossEstimate?: number | null;
}

export interface CameraOverlayProps {
  isLocked: boolean;
  streamInfo?: StreamInfo;
  isMirrored?: boolean;
  onToggleMirror?: () => void;
  children?: ReactNode;
}

export function CameraOverlay({
  isLocked,
  streamInfo,
  isMirrored = false,
  onToggleMirror,
  children,
}: CameraOverlayProps) {
  const tierLabel =
    streamInfo?.tier !== undefined && streamInfo.tier !== null
      ? streamInfo.tier === 0
        ? "T0 QR"
        : streamInfo.tier === 4
          ? "T4 Patch Modem"
          : `T${streamInfo.tier} Grid`
      : null;

  const goodputKb = streamInfo?.goodputBytesPerSecond
    ? `${(streamInfo.goodputBytesPerSecond / 1024).toFixed(1)} KB/s`
    : null;

  return (
    <div className={`camera-overlay ${isLocked ? "is-locked" : "is-searching"}`}>
      {/* Top Bar: Lock Status & Mirror Toggle */}
      <div className="overlay-top-bar">
        <div className={`status-badge ${isLocked ? "badge-locked" : "badge-searching"}`}>
          <span className="status-dot" />
          <span className="status-title">
            {isLocked ? "TRANSMISSION LOCKED" : "Searching for stream…"}
          </span>
          {tierLabel && <span className="tier-pill">{tierLabel}</span>}
          {goodputKb && <span className="speed-pill">{goodputKb}</span>}
        </div>

        {onToggleMirror && (
          <button
            type="button"
            className={`mirror-toggle-btn ${isMirrored ? "active" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggleMirror();
            }}
            title={isMirrored ? "Mirror mode is ON (click to unmirror)" : "Mirror mode is OFF (click to mirror)"}
          >
            ⇄ {isMirrored ? "Mirrored" : "Normal"}
          </button>
        )}
      </div>

      {/* Stream Info Line when locked */}
      {isLocked && streamInfo && (
        <div className="overlay-stream-details">
          {streamInfo.streamId && <span>Stream #{streamInfo.streamId.slice(0, 8)}</span>}
          {streamInfo.calibrated && <span className="calibrated-tag">✓ Calibrated</span>}
          {streamInfo.validFrames !== undefined && (
            <span>
              {streamInfo.validFrames}
              {streamInfo.totalFrames ? `/${streamInfo.totalFrames}` : ""} frames
            </span>
          )}
          {streamInfo.fps ? <span>{Math.round(streamInfo.fps)} fps</span> : null}
          {streamInfo.lossEstimate !== undefined && streamInfo.lossEstimate !== null ? (
            <span>loss {(streamInfo.lossEstimate * 100).toFixed(0)}%</span>
          ) : null}
        </div>
      )}

      {/* Reticle / Framing brackets */}
      <div className="overlay-reticle-container">
        <div className={`overlay-reticle-box ${isLocked ? "locked" : ""}`}>
          <span className="reticle-corner corner-tl" />
          <span className="reticle-corner corner-tr" />
          <span className="reticle-corner corner-bl" />
          <span className="reticle-corner corner-br" />
          {isLocked ? (
            <div className="reticle-hint locked">
              ✓ Streaming · Rotation invariant
            </div>
          ) : (
            <div className="reticle-hint">
              Fit phone screen inside frame · Any angle (0°, 90°, 180°, 270°)
            </div>
          )}
        </div>
      </div>

      {/* Bottom HUD */}
      {children && <div className="overlay-bottom-hud">{children}</div>}
    </div>
  );
}
