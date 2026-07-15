#!/usr/bin/env python3
"""
Dataset: aaozgur/fabric-defect-dataset-v4
Source:  https://huggingface.co/datasets/aaozgur/fabric-defect-dataset-v4

The dataset is distributed as a single Parquet file containing raw JPEG bytes
and metadata columns (defect_type, prompt, defects, descriptions).

How to download:

    pip install pandas pyarrow Pillow
    python download_dataset.py

The script downloads the Parquet file directly from HuggingFace, extracts all images, and organises them into:

    data/images/<defect_type>/image_xxx.jpg

The defect_type column value becomes the subfolder name and is used as the
anomaly class throughout the system. The current dataset produces four classes:

    burst          105 images
    lycra_run      107 images
    needle_break   105 images
    oil_stain      105 images

NOTE: The 422 images are already committed to this repository under data/images/.
Run this script only if you need to re-download them from scratch.
"""

import io
import sys
from pathlib import Path

PARQUET_URL = (
    "https://huggingface.co/datasets/aaozgur/fabric-defect-dataset-v4"
    "/resolve/main/data/train-00000-of-00001.parquet"
)
IMAGES_DIR = Path(__file__).parent / "images"


def main() -> None:
    if IMAGES_DIR.exists() and any(IMAGES_DIR.rglob("*.jpg")):
        print(f"Dataset already present at {IMAGES_DIR}. Delete it to re-download.")
        return

    try:
        import pandas as pd
        from PIL import Image
    except ImportError:
        print("Missing dependencies. Run: pip install pandas pyarrow Pillow")
        sys.exit(1)

    print(f"Downloading dataset from HuggingFace...")
    try:
        df = pd.read_parquet(PARQUET_URL)
    except Exception as exc:
        print(f"Download failed: {exc}")
        sys.exit(1)

    print(f"Extracting {len(df)} images...")
    counts: dict = {}

    for _, row in df.iterrows():
        class_name = row["defect_type"].lower().strip().replace(" ", "_").replace("-", "_")
        img_bytes = row["image"]["bytes"]
        filename = row["image"]["path"]

        dest_dir = IMAGES_DIR / class_name
        dest_dir.mkdir(parents=True, exist_ok=True)

        dest = dest_dir / (filename if filename.endswith(".jpg") else filename + ".jpg")
        img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
        img.save(dest, format="JPEG", quality=90)
        counts[class_name] = counts.get(class_name, 0) + 1

    print("Done.")
    for cls, cnt in sorted(counts.items()):
        print(f"  {cls:25s}  {cnt} images")
    print(f"\nTotal: {sum(counts.values())} images in {IMAGES_DIR}")
    print("Run 'docker compose up --build' to start the stack.")


if __name__ == "__main__":
    main()
