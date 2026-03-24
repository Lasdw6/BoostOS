from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

CODE_EXTENSIONS = {
    ".py", ".pyi", ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs",
    ".go", ".rs", ".java", ".kt", ".c", ".cpp", ".h", ".hpp",
    ".cs", ".rb", ".php", ".swift", ".sh", ".bash", ".zsh",
}

PROSE_EXTENSIONS = {".md", ".rst", ".txt"}

# Regex patterns that mark the start of a top-level definition
_BOUNDARY_PATTERNS = [
    re.compile(r"^(def |async def |class )\w"),           # Python
    re.compile(r"^(export\s+)?(default\s+)?(async\s+)?function\s+\w"),  # JS/TS
    re.compile(r"^(export\s+)?(abstract\s+|sealed\s+)?class\s+\w"),     # JS/TS/Java
    re.compile(r"^(const|let|var)\s+\w+\s*=\s*(async\s*)?(function|\()"),  # JS arrow/fn
    re.compile(r"^func\s+\w"),                            # Go
    re.compile(r"^(pub(\(crate\))?\s+)?(async\s+)?fn\s+\w"),  # Rust fn
    re.compile(r"^(pub(\(crate\))?\s+)?(struct|enum|impl|trait)\s+\w"),  # Rust types
]


@dataclass
class Chunk:
    file_path: str
    chunk_index: int
    start_line: int   # 1-based
    end_line: int     # 1-based inclusive
    language: str
    content: str


def chunk_file(file_path: str, text: str) -> list[Chunk]:
    if not text.strip():
        return []
    ext = Path(file_path).suffix.lower()
    if ext in CODE_EXTENSIONS:
        spans = _chunk_code(text)
    elif ext in PROSE_EXTENSIONS:
        spans = _chunk_prose(text)
    else:
        spans = _chunk_fixed(text, window=50, overlap=10)

    lang = _language(ext)
    return [
        Chunk(
            file_path=file_path,
            chunk_index=i,
            start_line=start,
            end_line=end,
            language=lang,
            content=content,
        )
        for i, (start, end, content) in enumerate(spans)
    ]


def _is_boundary(line: str) -> bool:
    for pat in _BOUNDARY_PATTERNS:
        if pat.match(line):
            return True
    return False


def _chunk_code(text: str) -> list[tuple[int, int, str]]:
    lines = text.splitlines()
    if not lines:
        return []

    boundaries = [i for i, line in enumerate(lines) if _is_boundary(line)]
    if not boundaries:
        return _chunk_fixed(text, window=40, overlap=10)

    chunks: list[tuple[int, int, str]] = []
    for idx, start in enumerate(boundaries):
        end = (boundaries[idx + 1] - 1) if idx + 1 < len(boundaries) else len(lines) - 1
        chunk_lines = lines[start : end + 1]
        if len(chunk_lines) > 60:
            sub = _chunk_fixed("\n".join(chunk_lines), window=40, overlap=10, offset=start)
            chunks.extend(sub)
        else:
            content = "\n".join(chunk_lines).strip()
            if len(content) >= 20:
                chunks.append((start + 1, end + 1, content))

    return chunks or _chunk_fixed(text, window=40, overlap=10)


def _chunk_prose(text: str) -> list[tuple[int, int, str]]:
    lines = text.splitlines()
    chunks: list[tuple[int, int, str]] = []
    seg_start = 0
    seg_lines: list[str] = []
    word_count = 0

    for i, line in enumerate(lines):
        words = len(line.split())
        if not line.strip() and seg_lines and word_count + words > 300:
            content = "\n".join(seg_lines).strip()
            if content:
                chunks.append((seg_start + 1, i, content))
            seg_start = i + 1
            seg_lines = []
            word_count = 0
            continue
        seg_lines.append(line)
        word_count += words

    if seg_lines:
        content = "\n".join(seg_lines).strip()
        if content:
            chunks.append((seg_start + 1, len(lines), content))

    return chunks or [(1, len(lines), text.strip())]


def _chunk_fixed(
    text: str,
    window: int = 40,
    overlap: int = 10,
    offset: int = 0,
) -> list[tuple[int, int, str]]:
    lines = text.splitlines()
    if not lines:
        return []
    if len(lines) <= window:
        content = text.strip()
        return [(offset + 1, offset + len(lines), content)] if content else []

    chunks: list[tuple[int, int, str]] = []
    step = max(1, window - overlap)
    i = 0
    while i < len(lines):
        end = min(i + window, len(lines))
        content = "\n".join(lines[i:end]).strip()
        if content:
            chunks.append((offset + i + 1, offset + end, content))
        if end == len(lines):
            break
        i += step
    return chunks


def _language(ext: str) -> str:
    _MAP = {
        ".py": "python", ".pyi": "python",
        ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript",
        ".ts": "typescript", ".jsx": "jsx", ".tsx": "tsx",
        ".go": "go", ".rs": "rust",
        ".java": "java", ".kt": "kotlin",
        ".c": "c", ".cpp": "cpp", ".h": "c", ".hpp": "cpp",
        ".cs": "csharp", ".rb": "ruby", ".php": "php", ".swift": "swift",
        ".sh": "shell", ".bash": "shell", ".zsh": "shell",
        ".md": "markdown", ".rst": "rst", ".txt": "text",
        ".json": "json", ".yaml": "yaml", ".yml": "yaml",
        ".toml": "toml", ".sql": "sql", ".html": "html",
        ".css": "css", ".scss": "scss",
    }
    return _MAP.get(ext, "text")
