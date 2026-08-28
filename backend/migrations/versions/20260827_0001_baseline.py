"""Establish the initial reservoir observer schema.

Revision ID: 20260827_0001
Revises:
Create Date: 2026-08-27
"""
from __future__ import annotations

from alembic import op

from backend.app.database import Base
from backend.app import models  # noqa: F401


revision = "20260827_0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    Base.metadata.create_all(bind=op.get_bind())


def downgrade() -> None:
    Base.metadata.drop_all(bind=op.get_bind())
