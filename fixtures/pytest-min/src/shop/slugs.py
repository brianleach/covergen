# A second module, so the whole-project baseline has an unimported file to report.
def slugify(name: str) -> str:
    return "-".join(name.strip().lower().split())
