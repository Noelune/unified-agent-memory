# -*- coding: utf-8 -*-
"""domain — pure model and policy: standard library only, no project imports.

Everything here is deterministic and side-effect free (the only "I/O" is the
console-encoding guard, which lives in infra). Layers above may import this
package freely; this package imports nothing from the project.
"""
