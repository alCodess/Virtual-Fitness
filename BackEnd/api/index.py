"""Vercel entrypoint for the Flask backend (lives under BackEnd/api)."""

# BackEnd is a package (BackEnd/__init__.py exists), so a direct import works
# without manual path munging in Vercel's Python runtime.
from BackEnd.index import app

