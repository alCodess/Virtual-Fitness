"""
Vercel entrypoint for the Flask backend.
Imports the existing app defined in BackEnd/index.py so Vercel's
Python runtime can locate the `app` object.
"""

import os
import sys

# Ensure the project root is on sys.path so `BackEnd` can be imported as a package.
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT_DIR not in sys.path:
    sys.path.append(ROOT_DIR)

from BackEnd.index import app as app

