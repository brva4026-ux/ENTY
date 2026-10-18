"""Rate limiting utilities."""
from slowapi import Limiter
from slowapi.util import get_remote_address

# Limiter por IP (funciona bien con x-forwarded-for real si detrás de proxy confiable)
limiter = Limiter(key_func=get_remote_address)
