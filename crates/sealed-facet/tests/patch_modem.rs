use sealed_facet::patch_modem::{
    render_patch_field, PatchPacket, PATCH_PAYLOAD_BYTES, TOTAL_PATCHES,
};
use sealed_facet::receiver::GridDecoder;
use sealed_facet::types::RgbaImage;

#[test]
fn test_patch_modem_round_trip() {
    // 1. Create 16 distinct packets (one for each patch in the 4×4 grid)
    let mut packets = Vec::new();
    for pid in 0..TOTAL_PATCHES {
        let mut payload = [0u8; PATCH_PAYLOAD_BYTES];
        for i in 0..PATCH_PAYLOAD_BYTES {
            payload[i] = ((pid * 17 + i * 3) & 0xff) as u8;
        }
        packets.push(PatchPacket {
            epoch: (pid % 4) as u8,
            r#type: if pid == 0 { 1 } else { 0 }, // first packet is descriptor, rest data
            patch_id: pid as u8,
            sbn: (pid / 4) as u8,
            esi: (pid * 10) as u16,
            payload,
        });
    }

    // 2. Render to RGBA image buffer (e.g. 600×600 pixels)
    let size_px = 600;
    let rgba_data = render_patch_field(&packets, size_px);
    let img = RgbaImage::new(size_px, size_px, &rgba_data);

    // 3. Decode with GridDecoder with tier 4 enabled (1 << 4 = 16)
    let mut dec = GridDecoder::new(1 << 4).expect("GridDecoder::new with tier 4");
    let decoded_frames = dec.push(&img);

    // 4. Verify all 16 patches decoded successfully
    assert_eq!(
        decoded_frames.len(),
        TOTAL_PATCHES,
        "All 16 patches should decode successfully from the rendered image"
    );

    for frame in decoded_frames {
        assert_eq!(frame.len(), 55, "Each packet must be exactly 55 bytes");

        // Verify header
        let header_byte_0 = frame[0];
        let epoch = (header_byte_0 >> 6) & 0x03;
        let type_code = (header_byte_0 >> 4) & 0x03;
        let patch_id = header_byte_0 & 0x0f;
        let sbn = frame[1];
        let esi = ((frame[2] as u16) << 8) | (frame[3] as u16);
        let len = frame[4] as usize;

        let original = &packets[patch_id as usize];
        assert_eq!(epoch, original.epoch);
        assert_eq!(type_code, original.r#type);
        assert_eq!(sbn, original.sbn);
        assert_eq!(esi, original.esi);
        assert_eq!(len, PATCH_PAYLOAD_BYTES);

        // Verify payload matches exactly
        assert_eq!(&frame[5..53], &original.payload[..]);
    }
}

#[test]
fn test_patch_modem_rotations() {
    let mut packets = Vec::new();
    for pid in 0..TOTAL_PATCHES {
        let mut payload = [0u8; PATCH_PAYLOAD_BYTES];
        for i in 0..PATCH_PAYLOAD_BYTES {
            payload[i] = ((pid * 13 + i * 7) & 0xff) as u8;
        }
        packets.push(PatchPacket {
            epoch: 0,
            r#type: 0,
            patch_id: pid as u8,
            sbn: 0,
            esi: pid as u16,
            payload,
        });
    }

    let size_px = 600;
    let rgba_data = render_patch_field(&packets, size_px);

    fn rot90(w: usize, h: usize, data: &[u8]) -> (usize, usize, Vec<u8>) {
        let mut out = vec![0u8; w * h * 4];
        for y in 0..h {
            for x in 0..w {
                let src = (y * w + x) * 4;
                let nx = h - 1 - y;
                let ny = x;
                let dst = (ny * h + nx) * 4;
                out[dst..dst + 4].copy_from_slice(&data[src..src + 4]);
            }
        }
        (h, w, out)
    }

    for rotation_steps in 1..=3 {
        let mut w = size_px;
        let mut h = size_px;
        let mut rotated = rgba_data.clone();
        for _ in 0..rotation_steps {
            let (nw, nh, nbytes) = rot90(w, h, &rotated);
            w = nw;
            h = nh;
            rotated = nbytes;
        }

        let img = RgbaImage::new(w, h, &rotated);
        let mut dec = GridDecoder::new(1 << 4).expect("GridDecoder::new");
        let decoded_frames = dec.push(&img);

        assert_eq!(
            decoded_frames.len(),
            TOTAL_PATCHES,
            "All 16 patches should decode at {} degrees rotation",
            rotation_steps * 90
        );
    }
}
