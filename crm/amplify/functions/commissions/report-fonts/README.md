# Payroll report fonts

These SIL Open Font License fonts are packaged in the report Lambda layer and subset into each PDF. There are no runtime font downloads. Noto Sans Regular/Bold replaces Helvetica; Noto Sans CJK supplies Chinese, Japanese and Korean glyphs within mixed-language names. No single font covers every Unicode script: missing glyphs fail explicitly, never silently replace a name with boxes.

- Noto Sans Regular/Bold: https://github.com/notofonts/noto-fonts/tree/main/hinted/ttf/NotoSans (LICENSE-NotoSans)
- Noto Sans CJK SC Regular: https://github.com/notofonts/noto-cjk/tree/main/Sans/Variable/TTF (LICENSE)

The same font assets are used by local tests and deployed rendering. Changing them requires checking text extraction, visual layout, deterministic retries and archived PDF size limits.

The CJK TrueType asset is a fixed `wght=400` instance of `NotoSansCJKsc-VF.ttf`, created with fontTools.varLib.instancer.instantiateVariableFont and saved with `font["glyf"].padding = 4`. Four-byte glyph alignment is required by the PDF font subsetter; without it some valid CJK outlines become corrupt even though text extraction still succeeds. A static TrueType font avoids the PDF library's CFF-subsetting failure and does not need conversion in Lambda.

Source variable-font SHA-256: `990c807e79c25662a5a9ecf7f971baeb2bf2eab9a559e5ecf15cdfdb8561d21f`.

Bundled asset SHA-256 values:
- `NotoSans-Regular.ttf`: `b85c38ecea8a7cfb39c24e395a4007474fa5a4fc864f6ee33309eb4948d232d5`
- `NotoSansCJKsc-Regular.ttf`: `33c3d9a74db6dcfba61e3dc47c42bb09a5b57433b59d867f7a591eb662e73e8d`
- `NotoSans-Bold.ttf`: `c976e4b1b99edc88775377fcc21692ca4bfa46b6d6ca6522bfda505b28ff9d6a`
