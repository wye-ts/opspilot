"""FROZEN v1 offline oracle (OpsPilot #59 Checkpoint A §5/§6).

This package is the historical v1 evaluation contract and scorer, preserved
so the offline v1 regression oracle keeps reproducing the frozen
ts-parity-v1.json fixture forever. It is UNWIRED from the active runtime:
the active service accepts contractVersion 2 only, and nothing in the active
evaluation path imports this package. Its only live consumer is
tests/test_scorer_parity_v1.py. None of these modules may change.
"""
