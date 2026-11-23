{
  description = "Real tabs for VS Code on Linux: one window, one VS Code (code serve-web) per tab";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      inherit (pkgs) lib;
      electron = pkgs.electron_45;

      # `code serve-web` downloads a generic Linux build of the VS Code server,
      # whose bundled node can't run on NixOS as is. VS Code supports pointing
      # that node at another glibc (it patchelfs it on start); these variables
      # make it use the one from nixpkgs. Already-set values win.
      serverEnv = {
        VSCODE_SERVER_CUSTOM_GLIBC_LINKER = "${pkgs.glibc}/lib/ld-linux-x86-64.so.2";
        VSCODE_SERVER_CUSTOM_GLIBC_PATH = "${pkgs.glibc}/lib:${pkgs.stdenv.cc.cc.lib}/lib";
        VSCODE_SERVER_PATCHELF_PATH = "${pkgs.patchelf}/bin/patchelf";
      };

      mkVscodeTabs =
        {
          codeFallback ? null,
        }:
        pkgs.buildNpmPackage {
          pname = "vscode-tabs";
          version = "0.1.0";
          src = lib.cleanSource self;
          npmDepsHash = "sha256-HMuCIn0Na5rrJd7iOflf5KZ22EZc/N1ja3hujdhNoIc=";
          env.ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
          nativeBuildInputs = [
            pkgs.makeWrapper
            pkgs.copyDesktopItems
          ];

          installPhase = ''
            runHook preInstall
            mkdir -p $out/share/vscode-tabs
            cp -r dist static package.json $out/share/vscode-tabs/
            makeWrapper ${lib.getExe electron} $out/bin/vscode-tabs \
              --add-flags $out/share/vscode-tabs \
              ${lib.concatStringsSep " " (lib.mapAttrsToList (k: v: "--set-default ${k} ${v}") serverEnv)} \
              ${lib.optionalString (codeFallback != null) "--set-default VSCODE_TABS_CODE_FALLBACK ${codeFallback}"}
            runHook postInstall
          '';

          desktopItems = [
            (pkgs.makeDesktopItem {
              name = "vscode-tabs";
              desktopName = "VS Code Tabs";
              comment = "VS Code with real tabs";
              exec = "vscode-tabs %F";
              icon = "vscode";
              categories = [
                "Development"
                "IDE"
              ];
              startupWMClass = "vscode-tabs";
            })
          ];

          meta = {
            description = "Real tabs for VS Code on Linux";
            license = lib.licenses.mit;
            mainProgram = "vscode-tabs";
            platforms = [ system ];
          };
        };

      # nixpkgs' (unfree) VS Code, used only by the with-vscode variant.
      vscode = (import nixpkgs { inherit system; config.allowUnfree = true; }).vscode;
    in
    {
      packages.${system} = {
        # Uses the `code` on your PATH.
        default = mkVscodeTabs { };
        # Falls back to nixpkgs' VS Code when there is no `code` on PATH.
        with-vscode = mkVscodeTabs { codeFallback = lib.getExe vscode; };
      };

      apps.${system} = {
        default = {
          type = "app";
          program = lib.getExe self.packages.${system}.default;
        };
        with-vscode = {
          type = "app";
          program = lib.getExe self.packages.${system}.with-vscode;
        };
      };

      # `nix develop`, then `npm install && npm start`.
      devShells.${system}.default = pkgs.mkShell {
        packages = [ pkgs.nodejs ];
        env = serverEnv // {
          ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
          # npm's prebuilt Electron doesn't run on NixOS; point the npm package at nixpkgs' build.
          ELECTRON_OVERRIDE_DIST_PATH = "${pkgs.runCommand "electron-dist" { } ''
            mkdir -p $out
            ln -s ${lib.getExe electron} $out/electron
          ''}";
        };
      };
    };
}
