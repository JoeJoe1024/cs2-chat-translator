{ config, lib, pkgs, ... }:

let
  cfg = config.programs.cs2-chat-translator;

  # User account for which config.json and default paths apply
  userName = cfg.user;

  # Home directory of that user, taken from NixOS user config
  userHome = config.users.users.${userName}.home or "/home/${userName}";

  # Reasonable defaults for Steam / CS2 paths
  defaultLogPath = "${userHome}/.local/share/Steam/steamapps/common/Counter-Strike Global Offensive/game/csgo/console.log";
  defaultCfgDir  = "${userHome}/.local/share/Steam/steamapps/common/Counter-Strike Global Offensive/game/csgo/cfg";

  # XDG config path (matches what your Node script already uses)
  configDir  = "${userHome}/.config/cs2-chat-translator";
  configFile = "${configDir}/config.json";
in
{
  options.programs.cs2-chat-translator = {
    enable = lib.mkEnableOption "CS2 Chat Translator";

    user = lib.mkOption {
      type = lib.types.str;
      default = "mecke";
      description = "User account for which the config.json and defaults are written.";
    };

    logPath = lib.mkOption {
      type = lib.types.str;
      default = defaultLogPath;
      description = "Path to CS2 console.log.";
    };

    cfgDir = lib.mkOption {
      type = lib.types.str;
      default = defaultCfgDir;
      description = "CS2 cfg directory (contains chat_reader.cfg).";
    };

    bindKey = lib.mkOption {
      type = lib.types.str;
      default = "l";
      description = "Key in CS2 bound to \"exec chat_reader.cfg\".";
    };
  };

  config = lib.mkIf cfg.enable {
    # Put the tool into the system PATH
    environment.systemPackages = [ pkgs.cs2-chat-translator ];

    # Create config directory and config.json in the user's home
    # using systemd-tmpfiles (runs at boot and can be triggered manually).
    systemd.tmpfiles.rules = [
      # Ensure the config directory exists
      "d ${configDir} 0755 ${userName} users -"
      # Ensure config.json exists with the desired contents
      "f ${configFile} 0644 ${userName} users - ${builtins.toJSON {
        logPath = cfg.logPath;
        cfgDir  = cfg.cfgDir;
        bindKey = cfg.bindKey;
      }}"
    ];
  };
}
