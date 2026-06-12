# Start with npm and detect package managers later

PullOps dogfoods with npm first because this repository already uses `package-lock.json`. Productized init should later detect the target package manager from lockfiles and generate matching Package Manager Commands, with config overrides for install and exec commands when detection is insufficient.
