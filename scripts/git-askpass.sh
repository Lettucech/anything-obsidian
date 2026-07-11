#!/bin/sh
case "$1" in
  *Username*) printf '%s\n' "${GIT_USERNAME:-x-access-token}" ;;
  *Password*) printf '%s\n' "$GIT_PASSWORD" ;;
  *) printf '\n' ;;
esac
