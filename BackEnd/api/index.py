"""
Vercel entrypoint for the Flask backend (lives under BackEnd/api).
"""

import os
import sys

# Ensure project root is on sys.path so BackEnd can be imported as a package.
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if ROOT_DIR not in sys.path:
    sys.path.append(ROOT_DIR)

from BackEnd.index import app as app

